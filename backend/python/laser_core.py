"""
Laser Marker Queue App - MD-X2520A
-----------------------------------
Playlist-style controller: click program buttons to queue jobs, they run
one after another automatically. Handles transient "busy" responses from
the marker by retrying instead of failing immediately.

Also includes a full Command Browser covering every command in the
KEYENCE MD-X2000/2500 series command reference (MD_UserManual_WW_GB_AS_167387
COMMAND.pdf / all_function.py). Commands that have both a "set" (WX) and a
"request" (RX) form are grouped under one entry with a WX/RX mode switch,
so you pick the command once and just toggle which direction to send.

Protocol notes (Keyence MD-X2000/2500 series command reference):
  - Commands are ASCII, terminated with \r
  - Success:  WX,OK
  - Failure:  WX,NG,<code>,<message>
  - Select job:  WX,JobNo=0007   (4-digit, zero padded, range 0000-1999)
  - Trigger marking: WX,StartMarking=1
  - Check status:    RX,Ready   ->  RX,OK,A
        A = 0 : READY ON (safe to trigger)
        A = 1 : READY OFF - an error is occurring
        A = 2 : READY OFF - marking or expansion in progress (busy)
  - The marker only replies once the operation is FULLY complete, so a
    reply of WX,OK to StartMarking means marking has actually finished.
"""

import socket
import threading
import queue
import time
import itertools

# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------
# LASER_IP_DEFAULT = "192.168.1.20"
# LASER_PORT_DEFAULT = 50002
LASER_IP_DEFAULT = "10.207.1.123"
LASER_PORT_DEFAULT = 9999
DELIMITER = b"\r"

PROGRAM_BUTTONS = list(range(1, 5))  # Job 0001 .. 0004

TRANSIENT_NG_KEYWORDS = ("Busy", "Controlling Shutter")

MAX_RETRY_WAIT = 60
RETRY_DELAY = 0.5

# ----------------------------------------------------------------------
# Command Definitions
# ----------------------------------------------------------------------
# Every entry in COMMAND_GROUPS is a dict:
#   {
#     "name": "Display Name",
#     "desc": "Short description shown under the selectors",
#     "wx":  {"template": "WX,...", "params": [ (label, default, width, fmt), ... ]},
#     "rx":  {"template": "RX,...", "params": [ ... ]},
#   }
# A group may have only "wx", only "rx", or both. When both are present the
# UI shows a WX(Set) / RX(Get) mode switch so you only pick the command once.
#
# param tuple = (label, default_text, entry_width, format_spec)
#   format_spec examples:
#     "04d"    -> zero-padded 4-digit integer (e.g. Job No)
#     "08.3f"  -> fixed 3-decimal float, 8 chars wide incl. sign/point
#     ""       -> raw string / raw digit, no conversion (e.g. free text, flags)
# ----------------------------------------------------------------------

JOB_P = ("Job No (0000-1999)", "0001", 8, "04d")
BLK_P = ("Block No (000-255)", "000", 6, "03d")


def _pp(label, default, width, fmt):
    """Small helper just for readability when building param lists."""
    return (label, default, width, fmt)


COMMAND_GROUPS = {
    # ==========================================================
    "Basic": [
        {"name": "Ready Status", "desc": "0=Ready 1=Error 2=Busy",
         "rx": {"template": "RX,Ready", "params": []}},

        {"name": "Job No.", "desc": "Set / get the currently selected job number",
         "wx": {"template": "WX,JobNo={p0}", "params": [JOB_P]},
         "rx": {"template": "RX,JobNo", "params": []}},

        {"name": "Job Title", "desc": "Set / get a job's title",
         "wx": {"template": "WX,JOB={p0},Title={p1}",
                "params": [JOB_P, _pp("Title", "MyJob", 20, "")]},
         "rx": {"template": "RX,JOB={p0},Title", "params": [JOB_P]}},

        {"name": "Start Marking", "desc": "Trigger marking (blocks until finished)",
         "wx": {"template": "WX,StartMarking={p0}",
                "params": [_pp("Mode 0=cancel-only 1=error-detail", "1", 4, "")]}},

        {"name": "Stop Marking", "desc": "Stop marking currently in progress",
         "wx": {"template": "WX,StopMarking", "params": []}},

        {"name": "Trigger Lock", "desc": "0=Enable external trigger 1=Disable",
         "wx": {"template": "WX,TriggerLock={p0}",
                "params": [_pp("0=Enable 1=Disable", "0", 4, "")]},
         "rx": {"template": "RX,TriggerLock", "params": []}},

        {"name": "Error Status / Clear", "desc": "Read current error, or clear it",
         "wx": {"template": "WX,ErrorClear", "params": []},
         "rx": {"template": "RX,Error", "params": []}},

        {"name": "Delete Job", "desc": "Delete job(s), comma-separated 4-digit, 9999=all",
         "wx": {"template": "WX,DeleteJob={p0}",
                "params": [_pp("Job No(s) e.g. 0001,0002", "0001", 20, "")]}},
    ],

    # ==========================================================
    "Laser Operation": [
        {"name": "Guide Laser", "desc": "Start guide laser (1=Once 2=Cont 3=Area 4=Work 5=Block)",
         "wx": {"template": "WX,GuideLaser={p0}",
                "params": [_pp("Type 1-5", "1", 4, "")]}},

        {"name": "Distance Pointer", "desc": "Turn distance pointer on/off",
         "wx": {"template": "WX,DistancePointer={p0}",
                "params": [_pp("0=OFF 1=ON", "1", 4, "")]},
         "rx": {"template": "RX,DistancePointer", "params": []}},

        {"name": "Lighting", "desc": "Turn internal lighting on/off",
         "wx": {"template": "WX,Lighting={p0}",
                "params": [_pp("0=OFF 1=ON", "1", 4, "")]},
         "rx": {"template": "RX,Lighting", "params": []}},

        {"name": "Camera Mode (Finder)", "desc": "Start/end camera finder mode",
         "wx": {"template": "WX,StartFinder", "params": []}},
        {"name": "End Camera Mode (Finder)", "desc": "End camera finder mode",
         "wx": {"template": "WX,EndFinder", "params": []}},

        {"name": "Finder Target", "desc": "Set / get finder target position + magnification",
         "wx": {"template": "WX,FinderTarget={p0},{p1},{p2},{p3}",
                "params": [_pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f"),
                           _pp("Magnification", "1", 4, "")]},
         "rx": {"template": "RX,FinderTarget", "params": []}},

        {"name": "Focus Check", "desc": "Check focus distance (1-10 times)",
         "wx": {"template": "WX,FocusCheck={p0}",
                "params": [_pp("Count (01-10)", "01", 4, "02d")]}},

        {"name": "Check 2D Code (v5)", "desc": "Full 2D-code verification check (17 params)",
         "wx": {"template": "WX,Check2DCode5={p0},{p1},{p2},{p3},{p4},{p5},{p6},{p7},{p8},{p9},{p10},{p11},{p12},{p13},{p14},{p15},{p16}",
                "params": [
                    _pp("a", "0", 4, ""), _pp("b", "0000.000", 10, "08.3f"),
                    _pp("c", "0000.000", 10, "08.3f"), _pp("d", "0000.000", 10, "08.3f"),
                    _pp("e", "000", 5, "03d"), _pp("f", "000", 5, "03d"),
                    _pp("g", "0", 4, ""), _pp("h", "0000", 6, "04d"),
                    _pp("i", "0", 4, ""), _pp("j", "0", 4, ""),
                    _pp("k", "0", 4, ""), _pp("l", "0", 4, ""),
                    _pp("m", "0", 4, ""), _pp("n", "0", 4, ""),
                    _pp("o", "0", 4, ""), _pp("p", "0000", 6, "04d"),
                    _pp("q", "00000", 7, "05d"),
                ]}},

        {"name": "Z Tracking Point Check", "desc": "Check a Z tracking point",
         "wx": {"template": "WX,ZTrackingPointCheck={p0},{p1},{p2},{p3},{p4}",
                "params": [_pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "000.000", 9, "07.3f"),
                           _pp("Count (01-99)", "01", 4, "02d"),
                           _pp("Cycle", "0", 4, "")]}},

        {"name": "XY Tracking (run)", "desc": "Execute XY tracking No.",
         "wx": {"template": "WX,XYTracking={p0}",
                "params": [_pp("TRK No (00-99)", "00", 4, "02d")]}},
        {"name": "Z Tracking (run)", "desc": "Execute Z tracking No.",
         "wx": {"template": "WX,ZTracking={p0}",
                "params": [_pp("TRK No (000-999)", "000", 6, "03d")]}},

        {"name": "Z Tracking Matrix Cell", "desc": "Select Z tracking matrix cell by row/col",
         "wx": {"template": "WX,ZTrackingMatrixCell={p0},{p1}",
                "params": [_pp("Row", "000", 6, "03d"), _pp("Col", "000", 6, "03d")]}},
        {"name": "Z Tracking Matrix Cell No.", "desc": "Select Z tracking matrix cell by index",
         "wx": {"template": "WX,ZTrackingMatrixCellNo={p0}",
                "params": [_pp("Cell No (00001-65025)", "00001", 8, "05d")]}},

        {"name": "3-Axis Tracking (run)", "desc": "Execute 3-axis tracking",
         "wx": {"template": "WX,3AxisTracking", "params": []}},
        {"name": "Z Tracking Manual Calibration", "desc": "Run manual calibration",
         "wx": {"template": "WX,ZTrackingManualCalibration", "params": []}},
    ],

    # ==========================================================
    "Current Values": [
        {"name": "Counter", "desc": "Set / get a job's counter value",
         "wx": {"template": "WX,JOB={p0},CTR={p1},Counter={p2},{p3}",
                "params": [JOB_P, _pp("Counter No (0-9/A-J)", "0", 4, ""),
                           _pp("Current Value", "0000000000", 12, "010d"),
                           _pp("Repeat Count", "0000000000", 12, "010d")]},
         "rx": {"template": "RX,JOB={p0},CTR={p1},Counter",
                "params": [JOB_P, _pp("Counter No (0-9/A-J)", "0", 4, "")]}},

        {"name": "IO Encoded Character", "desc": "Set / get I/O encoded character",
         "wx": {"template": "WX,IoEncodedCharacter={p0}",
                "params": [_pp("Encoded Char No (00-35)", "00", 4, "02d")]},
         "rx": {"template": "RX,IoEncodedCharacter", "params": []}},

        {"name": "Marked Character", "desc": "Request last marked string for a block",
         "rx": {"template": "RX,MarkedCharacter={p0},{p1}", "params": [JOB_P, BLK_P]}},

        {"name": "Marking Result", "desc": "Request last marking result",
         "rx": {"template": "RX,MarkingResult", "params": []}},
        {"name": "Workflow Result Detail 2", "desc": "Request last workflow result",
         "rx": {"template": "RX,WorkflowResultDetail2", "params": []}},
    ],

    # ==========================================================
    "Controller Setup": [
        {"name": "All Position", "desc": "Set / get overall position correction",
         "wx": {"template": "WX,AllPosition={p0},{p1},{p2},{p3},{p4},{p5}",
                "params": [_pp("X-rot deg", "0000.000", 10, "08.3f"),
                           _pp("Y-rot deg", "0000.000", 10, "08.3f"),
                           _pp("Theta deg", "0000.000", 10, "08.3f"),
                           _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,AllPosition", "params": []}},

        {"name": "Time Setting", "desc": "Set / get controller date and time",
         "wx": {"template": "WX,TimeSetting={p0},{p1},{p2},{p3},{p4},{p5}",
                "params": [_pp("Year", "2026", 6, "04d"), _pp("Month", "01", 4, "02d"),
                           _pp("Day", "01", 4, "02d"), _pp("Hour", "00", 4, "02d"),
                           _pp("Min", "00", 4, "02d"), _pp("Sec", "00", 4, "02d")]},
         "rx": {"template": "RX,TimeSetting", "params": []}},

        {"name": "Power Offset", "desc": "Set / get laser power offset %",
         "wx": {"template": "WX,PowerOffset={p0}",
                "params": [_pp("Offset% (-100 to 100)", "0000.0", 8, "06.1f")]},
         "rx": {"template": "RX,PowerOffset", "params": []}},

        {"name": "Barcode Verification", "desc": "Set expected barcode verification string",
         "wx": {"template": "WX,BarcodeVerification={p0}",
                "params": [_pp("String", "", 20, "")]}},

        {"name": "Laser Safety Module Shutter", "desc": "Set / get safety module shutter",
         "wx": {"template": "WX,LaserSafetyModuleShutter={p0}",
                "params": [_pp("0=Close 1=Open", "0", 4, "")]},
         "rx": {"template": "RX,LaserSafetyModuleShutter", "params": []}},

        {"name": "Print Complete Timing", "desc": "0=After mark 1=After camera",
         "wx": {"template": "WX,PrintCompTiming={p0}",
                "params": [_pp("0 or 1", "0", 4, "")]},
         "rx": {"template": "RX,PrintCompTiming", "params": []}},

        {"name": "Add Route Table", "desc": "Add a network route",
         "wx": {"template": "WX,AddRouteTable={p0},{p1},{p2}",
                "params": [_pp("Dest IP", "0.0.0.0", 16, ""),
                           _pp("Mask", "255.255.255.0", 16, ""),
                           _pp("Gateway", "0.0.0.0", 16, "")]}},
        {"name": "Delete Route Table", "desc": "Delete a network route",
         "wx": {"template": "WX,DeleteRouteTable={p0},{p1}",
                "params": [_pp("Dest IP", "0.0.0.0", 16, ""), _pp("Mask", "255.255.255.0", 16, "")]}},
        {"name": "Delete All Route Table", "desc": "Delete all routes",
         "wx": {"template": "WX,DeleteAllRouteTable", "params": []}},
        {"name": "Route Table Setting Count", "desc": "Number of configured routes",
         "rx": {"template": "RX,GetRouteTableSettingNum", "params": []}},
        {"name": "Route Table Setting", "desc": "Request a specific route entry",
         "rx": {"template": "RX,GetRouteTableSetting={p0}",
                "params": [_pp("Index", "0", 4, "")]}},

        {"name": "Z Timing", "desc": "Set / get Z timing (us) and matrix-apply flag",
         "wx": {"template": "WX,ZTiming={p0},{p1}",
                "params": [_pp("Timing us (0-4000)", "0000", 6, "04d"),
                           _pp("Apply to matrix 0/1", "0", 4, "")]},
         "rx": {"template": "RX,ZTiming", "params": []}},

        {"name": "Constant Alignment View", "desc": "Enable/disable constant alignment view",
         "wx": {"template": "WX,ConstantAlignmentViewEnable={p0}",
                "params": [_pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,ConstantAlignmentViewEnable", "params": []}},
    ],

    # ==========================================================
    "Job Settings": [
        {"name": "On The Fly (Static/Moving)", "desc": "0=Static 1=Moving + direction",
         "wx": {"template": "WX,JOB={p0},OnTheFly={p1},{p2}",
                "params": [JOB_P, _pp("0=Static 1=Moving", "0", 4, ""),
                           _pp("Direction 0-3", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},OnTheFly", "params": [JOB_P]}},

        {"name": "Head Direction", "desc": "Set / get head orientation",
         "wx": {"template": "WX,JOB={p0},HeadDirection={p1}",
                "params": [JOB_P, _pp("Direction", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},HeadDirection", "params": [JOB_P]}},

        {"name": "Marking Order", "desc": "Set / get block marking order",
         "wx": {"template": "WX,JOB={p0},MarkingOrder={p1}",
                "params": [JOB_P, _pp("Order", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},MarkingOrder", "params": [JOB_P]}},

        {"name": "Continuous Stationary Marking", "desc": "Set / get repeat marking on fixed part",
         "wx": {"template": "WX,JOB={p0},ContinuousStationaryMarking={p1},{p2},{p3}",
                "params": [JOB_P, _pp("Setting", "0", 4, ""),
                           _pp("Count (00000-65000)", "00001", 7, "05d"),
                           _pp("Interval sec", "0000.0", 8, "06.1f")]},
         "rx": {"template": "RX,JOB={p0},ContinuousStationaryMarking", "params": [JOB_P]}},

        {"name": "On-The-Fly Marking", "desc": "Set / get moving-marking method",
         "wx": {"template": "WX,JOB={p0},OnTheFlyMarking={p1},{p2},{p3},{p4}",
                "params": [JOB_P, _pp("Method", "0", 4, ""),
                           _pp("Speed mm/s", "0000.0", 8, "06.1f"),
                           _pp("Mode", "0", 4, ""),
                           _pp("Pulse", "00.0", 6, "05.1f")]},
         "rx": {"template": "RX,JOB={p0},OnTheFlyMarking", "params": [JOB_P]}},

        {"name": "On-The-Fly Trigger Delay", "desc": "Set / get trigger delay distance/offset",
         "wx": {"template": "WX,JOB={p0},OnTheFlyTriggerDelay={p1},{p2}",
                "params": [JOB_P, _pp("Distance mm", "0000.0", 8, "06.1f"),
                           _pp("Offset mm", "00000.0", 9, "07.1f")]},
         "rx": {"template": "RX,JOB={p0},OnTheFlyTriggerDelay", "params": [JOB_P]}},

        {"name": "On-The-Fly Continuous Marking", "desc": "Set / get repeated moving marking",
         "wx": {"template": "WX,JOB={p0},OnTheFlyContinuousMarking={p1},{p2},{p3}",
                "params": [JOB_P, _pp("Setting", "0", 4, ""),
                           _pp("Count (00000-65000)", "00001", 7, "05d"),
                           _pp("Interval sec", "0000.0", 8, "06.1f")]},
         "rx": {"template": "RX,JOB={p0},OnTheFlyContinuousMarking", "params": [JOB_P]}},

        {"name": "On-The-Fly Marking Area", "desc": "Set / get moving marking start/end area",
         "wx": {"template": "WX,JOB={p0},OnTheFlyMarkingArea={p1},{p2},{p3}",
                "params": [JOB_P, _pp("Setting", "0", 4, ""),
                           _pp("Start mm", "0000.000", 10, "08.3f"),
                           _pp("End mm", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},OnTheFlyMarkingArea", "params": [JOB_P]}},

        {"name": "Sort Method (Move Printing)", "desc": "Set / get block sort method",
         "wx": {"template": "WX,SortMethodMovePrinting={p0}",
                "params": [_pp("Method", "0", 4, "")]},
         "rx": {"template": "RX,SortMethodMovePrinting", "params": []}},

        {"name": "Job Position", "desc": "Set / get workpiece position adjustment",
         "wx": {"template": "WX,JOB={p0},JobPosition={p1},{p2},{p3},{p4},{p5}",
                "params": [JOB_P, _pp("Ref X mm", "0000.000", 10, "08.3f"),
                           _pp("Ref Y mm", "0000.000", 10, "08.3f"),
                           _pp("Corr X mm", "0000.000", 10, "08.3f"),
                           _pp("Corr Y mm", "0000.000", 10, "08.3f"),
                           _pp("Theta deg", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},JobPosition", "params": [JOB_P]}},

        {"name": "Height Correction", "desc": "Set / get automatic height correction",
         "wx": {"template": "WX,JOB={p0},HeightCorrection={p1},{p2},{p3},{p4},{p5},{p6}",
                "params": [JOB_P, _pp("Method", "0", 4, ""),
                           _pp("Z mm", "000.000", 9, "07.3f"),
                           _pp("Count", "0", 4, ""),
                           _pp("Upper mm", "000.000", 9, "07.3f"),
                           _pp("Lower mm", "000.000", 9, "07.3f"),
                           _pp("Out-of-range action", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},HeightCorrection", "params": [JOB_P]}},

        {"name": "Common Marking Parameter", "desc": "Set / get job-wide default marking params",
         "wx": {"template": "WX,JOB={p0},CommonMarkingParameter={p1},{p2},{p3},{p4},{p5},{p6},{p7},{p8},{p9},{p10},{p11}",
                "params": [JOB_P,
                           _pp("Power %", "050.0", 7, "05.1f"),
                           _pp("Speed mm/s", "01000", 7, "05d"),
                           _pp("Frequency kHz", "100", 5, "03d"),
                           _pp("Spot um", "0080", 6, "04d"),
                           _pp("Count", "001", 5, "03d"),
                           _pp("Z mm", "0000.000", 10, "08.3f"),
                           _pp("Fill mm", "0.050", 7, "05.3f"),
                           _pp("Quality", "01", 4, "02d"),
                           _pp("Skip mm", "00.000", 8, "06.3f"),
                           _pp("Enable EP 0/1", "0", 4, ""),
                           _pp("EP On/Off", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},CommonMarkingParameter", "params": [JOB_P]}},

        {"name": "Marking Energy", "desc": "Set / get power-monitor energy thresholds",
         "wx": {"template": "WX,JOB={p0},MarkingEnergy={p1},{p2},{p3},{p4}",
                "params": [JOB_P, _pp("Lower Enable", "0", 4, ""),
                           _pp("Upper Enable", "0", 4, ""),
                           _pp("Lower Value", "0000.00", 9, "08.2f"),
                           _pp("Upper Value", "0000.00", 9, "08.2f")]},
         "rx": {"template": "RX,JOB={p0},MarkingEnergy", "params": [JOB_P]}},

        {"name": "Scanner Waiting", "desc": "Set / get scanner waiting position",
         "wx": {"template": "WX,JOB={p0},ScannerWaiting={p1},{p2},{p3},{p4}",
                "params": [JOB_P, _pp("Coord system", "0", 4, ""),
                           _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},ScannerWaiting", "params": [JOB_P]}},

        {"name": "Camera Waiting Scale", "desc": "Set / get camera-waiting zoom scale",
         "wx": {"template": "WX,JOB={p0},CameraWaitingScale={p1}",
                "params": [JOB_P, _pp("Magnification", "1", 4, "")]},
         "rx": {"template": "RX,JOB={p0},CameraWaitingScale", "params": [JOB_P]}},

        {"name": "Camera Waiting Light", "desc": "Set / get internal light during camera wait",
         "wx": {"template": "WX,JOB={p0},CameraWaitingLight={p1}",
                "params": [JOB_P, _pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},CameraWaitingLight", "params": [JOB_P]}},

        {"name": "Camera Waiting External Light", "desc": "Set / get external light during camera wait",
         "wx": {"template": "WX,JOB={p0},CameraWaitingExternalLight={p1}",
                "params": [JOB_P, _pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},CameraWaitingExternalLight", "params": [JOB_P]}},

        {"name": "Lighting Type", "desc": "Set / get job lighting type",
         "wx": {"template": "WX,JOB={p0},LightingType={p1}",
                "params": [JOB_P, _pp("Type", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},LightingType", "params": [JOB_P]}},

        {"name": "Approach Scan Speed", "desc": "Set / get approach scan speed",
         "wx": {"template": "WX,JOB={p0},ApproachScanSpeed={p1}",
                "params": [JOB_P, _pp("Speed", "01000", 7, "05d")]},
         "rx": {"template": "RX,JOB={p0},ApproachScanSpeed", "params": [JOB_P]}},
    ],

    # ==========================================================
    "String / Logo / Barcode": [
        {"name": "Block Type", "desc": "Set / get block type",
         "wx": {"template": "WX,JOB={p0},BLK={p1},BlockType={p2}",
                "params": [JOB_P, BLK_P, _pp("Type", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},BlockType", "params": [JOB_P, BLK_P]}},

        {"name": "Code Type", "desc": "Set / get barcode/2D code type",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CodeType={p2}",
                "params": [JOB_P, BLK_P, _pp("Type", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CodeType", "params": [JOB_P, BLK_P]}},

        {"name": "Character String", "desc": "Set / get block character string",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CharacterString={p2}",
                "params": [JOB_P, BLK_P, _pp("String", "TEST", 20, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CharacterString", "params": [JOB_P, BLK_P]}},

        {"name": "Character Font", "desc": "Set / get font, line, thickness, line-count settings",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CharacterFont={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, BLK_P, _pp("Font", "00", 4, "02d"),
                           _pp("Line Type", "0", 4, ""),
                           _pp("Thickness mm", "0.000", 7, "05.3f"),
                           _pp("Auto Lines", "0", 4, ""),
                           _pp("Lines", "001", 5, "03d"),
                           _pp("Overlap", "0.0", 6, "04.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CharacterFont", "params": [JOB_P, BLK_P]}},

        {"name": "Character Size", "desc": "Set / get char height/width/spacing/pitch",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CharacterSize={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, BLK_P,
                           _pp("Height mm", "0.000", 9, "07.3f"),
                           _pp("Width mm", "0.000", 9, "07.3f"),
                           _pp("Layout", "0", 4, ""),
                           _pp("Space mm", "0000.000", 10, "08.3f"),
                           _pp("Full-width mm", "0.000", 9, "07.3f"),
                           _pp("Pitch mm", "0.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CharacterSize", "params": [JOB_P, BLK_P]}},

        {"name": "Logo Size", "desc": "Set / get logo height/width",
         "wx": {"template": "WX,JOB={p0},BLK={p1},LogoSize={p2},{p3}",
                "params": [JOB_P, BLK_P, _pp("Height mm", "0.000", 9, "07.3f"),
                           _pp("Width mm", "0.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},LogoSize", "params": [JOB_P, BLK_P]}},

        {"name": "Character Proportional", "desc": "Set / get proportional spacing",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CharacterProportional={p2},{p3}",
                "params": [JOB_P, BLK_P, _pp("Setting", "0", 4, ""),
                           _pp("Min Width %", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CharacterProportional", "params": [JOB_P, BLK_P]}},

        {"name": "Character Ratio", "desc": "Set / get width/space scaling ratio",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CharacterRatio={p2},{p3},{p4}",
                "params": [JOB_P, BLK_P, _pp("Setting", "0", 4, ""),
                           _pp("Width Ratio %", "100.00", 8, "06.2f"),
                           _pp("Space Ratio %", "100.00", 9, "07.2f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CharacterRatio", "params": [JOB_P, BLK_P]}},

        {"name": "Arc Character", "desc": "Set / get arc layout parameters",
         "wx": {"template": "WX,JOB={p0},BLK={p1},ArcCharacter={p2},{p3},{p4},{p5},{p6}",
                "params": [JOB_P, BLK_P, _pp("Layout", "0", 4, ""),
                           _pp("Radius mm", "0000.000", 10, "08.3f"),
                           _pp("Space mm", "0000.000", 10, "08.3f"),
                           _pp("Angle Space deg", "000.000", 9, "07.3f"),
                           _pp("Open Angle deg", "000.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},ArcCharacter", "params": [JOB_P, BLK_P]}},

        {"name": "Code Setting", "desc": "Set / get barcode/2D code format & check digit",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CodeSetting={p2},{p3},{p4},{p5}",
                "params": [JOB_P, BLK_P, _pp("Format", "0", 4, ""),
                           _pp("Check Digit", "0", 4, ""),
                           _pp("Macro", "0", 4, ""),
                           _pp("QR Correction", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CodeSetting", "params": [JOB_P, BLK_P]}},

        {"name": "Barcode Size", "desc": "Set / get 1D barcode dimensions",
         "wx": {"template": "WX,JOB={p0},BLK={p1},BarcodeSize={p2},{p3},{p4},{p5}",
                "params": [JOB_P, BLK_P, _pp("Height mm", "0.000", 9, "07.3f"),
                           _pp("Narrow Bar mm", "0.000", 8, "06.3f"),
                           _pp("Bar Ratio", "2.0", 7, "05.1f"),
                           _pp("Quiet Zone", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},BarcodeSize", "params": [JOB_P, BLK_P]}},

        {"name": "GS1 DataBar Size", "desc": "Set / get GS1 DataBar dimensions",
         "wx": {"template": "WX,JOB={p0},BLK={p1},GS1DataBarSize={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, BLK_P, _pp("Module Width mm", "0.000", 8, "06.3f"),
                           _pp("Linear Height mm", "0.000", 9, "07.3f"),
                           _pp("Sep Height mm", "0.000", 7, "05.3f"),
                           _pp("TD Height mm", "0.000", 7, "05.3f"),
                           _pp("Guard", "00", 4, "02d"),
                           _pp("Quiet Zone", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},GS1DataBarSize", "params": [JOB_P, BLK_P]}},

        {"name": "Data Matrix Size", "desc": "Set / get Data Matrix symbol/cell size",
         "wx": {"template": "WX,JOB={p0},BLK={p1},DataMatrixSize={p2},{p3},{p4}",
                "params": [JOB_P, BLK_P, _pp("Symbol Size", "0000", 6, "04d"),
                           _pp("Cell Size mm", "0.000", 8, "06.3f"),
                           _pp("Quiet Zone", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},DataMatrixSize", "params": [JOB_P, BLK_P]}},

        {"name": "Data Matrix Cell Ratio X", "desc": "Set / get X cell-size ratio",
         "wx": {"template": "WX,JOB={p0},BLK={p1},DataMatrixCellSizeRatioX={p2}",
                "params": [JOB_P, BLK_P, _pp("Ratio %", "100.0", 7, "05.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},DataMatrixCellSizeRatioX", "params": [JOB_P, BLK_P]}},
        {"name": "Data Matrix Cell Ratio Y", "desc": "Set / get Y cell-size ratio",
         "wx": {"template": "WX,JOB={p0},BLK={p1},DataMatrixCellSizeRatioY={p2}",
                "params": [JOB_P, BLK_P, _pp("Ratio %", "100.0", 7, "05.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},DataMatrixCellSizeRatioY", "params": [JOB_P, BLK_P]}},

        {"name": "QR Code Size", "desc": "Set / get QR version/cell size/mode",
         "wx": {"template": "WX,JOB={p0},BLK={p1},QRCodeSize={p2},{p3},{p4},{p5}",
                "params": [JOB_P, BLK_P, _pp("Version", "0000", 6, "04d"),
                           _pp("Cell Size mm", "0.000", 8, "06.3f"),
                           _pp("Mode", "0", 4, ""),
                           _pp("Quiet Zone", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},QRCodeSize", "params": [JOB_P, BLK_P]}},

        {"name": "QR Code Cell Ratio X", "desc": "Set / get X cell-size ratio",
         "wx": {"template": "WX,JOB={p0},BLK={p1},QRCodeCellSizeRatioX={p2}",
                "params": [JOB_P, BLK_P, _pp("Ratio %", "100.0", 7, "05.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},QRCodeCellSizeRatioX", "params": [JOB_P, BLK_P]}},
        {"name": "QR Code Cell Ratio Y", "desc": "Set / get Y cell-size ratio",
         "wx": {"template": "WX,JOB={p0},BLK={p1},QRCodeCellSizeRatioY={p2}",
                "params": [JOB_P, BLK_P, _pp("Ratio %", "100.0", 7, "05.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},QRCodeCellSizeRatioY", "params": [JOB_P, BLK_P]}},

        {"name": "Code/Cell/Logo Ratio", "desc": "Set / get code cell-to-logo ratio",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CodeCellLogoRatio={p2}",
                "params": [JOB_P, BLK_P, _pp("Ratio %", "100.0", 7, "05.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CodeCellLogoRatio", "params": [JOB_P, BLK_P]}},

        {"name": "Block Position", "desc": "Set / get block XYZ position",
         "wx": {"template": "WX,JOB={p0},BLK={p1},BlockPosition={p2},{p3},{p4}",
                "params": [JOB_P, BLK_P, _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},BlockPosition", "params": [JOB_P, BLK_P]}},

        {"name": "Block Layout", "desc": "Set / get reference point, angle, char-angle",
         "wx": {"template": "WX,JOB={p0},BLK={p1},BlockLayout={p2},{p3},{p4},{p5},{p6}",
                "params": [JOB_P, BLK_P, _pp("Ref Point", "0", 4, ""),
                           _pp("Angle deg", "0000.000", 10, "08.3f"),
                           _pp("Start Angle deg", "0000.000", 10, "08.3f"),
                           _pp("Use Char Angle", "0", 4, ""),
                           _pp("Char Angle deg", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},BlockLayout", "params": [JOB_P, BLK_P]}},

        {"name": "Fixed-Point Processing Time", "desc": "Set / get wait time at fixed point",
         "wx": {"template": "WX,JOB={p0},BLK={p1},FixedPointProcessingTime={p2}",
                "params": [JOB_P, BLK_P, _pp("Time ms", "00000.0", 9, "07.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},FixedPointProcessingTime", "params": [JOB_P, BLK_P]}},

        {"name": "Marking Enable Flags", "desc": "Set/get which characters in block are marked",
         "wx": {"template": "WX,JOB={p0},BLK={p1},MarkingEnable={p2},{p3}",
                "params": [JOB_P, BLK_P, _pp("Reset Flag", "0", 4, ""),
                           _pp("Flags", "1", 10, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},MarkingEnable", "params": [JOB_P, BLK_P]}},
    ],

    # ==========================================================
    "Marking Parameters": [
        {"name": "Marking Parameter", "desc": "Set / get power/speed/freq/spot/count for a block",
         "wx": {"template": "WX,JOB={p0},BLK={p1},MarkingParameter={p2},{p3},{p4},{p5},{p6}",
                "params": [JOB_P, BLK_P, _pp("Power %", "050.0", 7, "05.1f"),
                           _pp("Speed mm/s", "01000", 7, "05d"),
                           _pp("Frequency kHz", "100", 5, "03d"),
                           _pp("Spot um", "0080", 6, "04d"),
                           _pp("Count", "001", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},MarkingParameter", "params": [JOB_P, BLK_P]}},

        {"name": "Code Pattern", "desc": "Set / get 2D code drawing pattern order",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CodePattern={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, BLK_P, _pp("Pattern", "000", 5, "03d"),
                           _pp("Finder", "000", 5, "03d"),
                           _pp("Alignment", "000", 5, "03d"),
                           _pp("Cell", "000", 5, "03d"),
                           _pp("Order", "000", 5, "03d"),
                           _pp("Count", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CodePattern", "params": [JOB_P, BLK_P]}},

        {"name": "Hatch Pattern", "desc": "Set / get fill hatch pattern",
         "wx": {"template": "WX,JOB={p0},BLK={p1},HatchPattern={p2},{p3},{p4},{p5},{p6},{p7},{p8}",
                "params": [JOB_P, BLK_P, _pp("Fill Type", "0", 4, ""),
                           _pp("Pattern", "0", 4, ""), _pp("Direction", "0", 4, ""),
                           _pp("Contour Dir", "0", 4, ""), _pp("Start Pos", "0", 4, ""),
                           _pp("Fill Angle deg", "000", 5, "03d"),
                           _pp("Cross Angle deg", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},HatchPattern", "params": [JOB_P, BLK_P]}},

        {"name": "TTF Pattern", "desc": "Set / get TrueType-font fill pattern",
         "wx": {"template": "WX,JOB={p0},BLK={p1},TTFPattern={p2},{p3},{p4},{p5},{p6}",
                "params": [JOB_P, BLK_P, _pp("Fill Type", "0", 4, ""),
                           _pp("Pattern", "0", 4, ""), _pp("Direction", "0", 4, ""),
                           _pp("Fill Angle deg", "000", 5, "03d"),
                           _pp("Cross Angle deg", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},TTFPattern", "params": [JOB_P, BLK_P]}},

        {"name": "Code Fill Parameter", "desc": "Set / get code fill interval/shrink",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CodeFillParameter={p2},{p3}",
                "params": [JOB_P, BLK_P, _pp("Fill Interval mm", "0.050", 7, "05.3f"),
                           _pp("Shrink Fill mm", "00.000", 8, "06.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CodeFillParameter", "params": [JOB_P, BLK_P]}},

        {"name": "Hatch Parameter", "desc": "Set / get hatch fill/skip/overprint settings",
         "wx": {"template": "WX,JOB={p0},BLK={p1},HatchParameter={p2},{p3},{p4},{p5},{p6},{p7},{p8},{p9}",
                "params": [JOB_P, BLK_P, _pp("Fill Interval mm", "0.050", 7, "05.3f"),
                           _pp("Shrink Fill mm", "00.000", 8, "06.3f"),
                           _pp("Skip Line", "000", 5, "03d"),
                           _pp("Overprint", "0", 4, ""),
                           _pp("Overprint Dir", "0", 4, ""),
                           _pp("Overprint Count", "000", 5, "03d"),
                           _pp("Shrink Boundary mm", "00.000", 8, "06.3f"),
                           _pp("Writing Order", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},HatchParameter", "params": [JOB_P, BLK_P]}},

        {"name": "TTF Parameter", "desc": "Set / get TTF fill/skip/overprint settings",
         "wx": {"template": "WX,JOB={p0},BLK={p1},TTFParameter={p2},{p3},{p4},{p5},{p6},{p7},{p8},{p9}",
                "params": [JOB_P, BLK_P, _pp("Fill Interval mm", "0.050", 7, "05.3f"),
                           _pp("Shrink Fill mm", "00.000", 8, "06.3f"),
                           _pp("Skip Line", "000", 5, "03d"),
                           _pp("Overprint", "0", 4, ""),
                           _pp("Overprint Dir", "0", 4, ""),
                           _pp("Overprint Count", "000", 5, "03d"),
                           _pp("Shrink Boundary mm", "00.000", 8, "06.3f"),
                           _pp("Writing Order", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},TTFParameter", "params": [JOB_P, BLK_P]}},

        {"name": "Photo Setting", "desc": "Set / get gamma/contrast/brightness for photo blocks",
         "wx": {"template": "WX,JOB={p0},BLK={p1},PhotoSetting={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, BLK_P, _pp("Gamma", "1.00", 6, "04.2f"),
                           _pp("Contrast", "0000", 6, "04d"),
                           _pp("Contrast Enhance", "0", 4, ""),
                           _pp("Brightness", "0000", 6, "04d"),
                           _pp("Skip Dots", "0", 4, ""),
                           _pp("Intensity", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},PhotoSetting", "params": [JOB_P, BLK_P]}},

        {"name": "Fill Marking Parameter", "desc": "Set / get separate power/speed for fill",
         "wx": {"template": "WX,JOB={p0},BLK={p1},FillMarkingParameter={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, BLK_P, _pp("Enable", "0", 4, ""),
                           _pp("Power %", "050.0", 7, "05.1f"),
                           _pp("Speed mm/s", "01000", 7, "05d"),
                           _pp("Frequency kHz", "100", 5, "03d"),
                           _pp("Spot um", "0080", 6, "04d"),
                           _pp("Count", "001", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},FillMarkingParameter", "params": [JOB_P, BLK_P]}},

        {"name": "Jump Speed", "desc": "Set / get scanner jump speed for a block",
         "wx": {"template": "WX,JOB={p0},BLK={p1},JumpSpeed={p2}",
                "params": [JOB_P, BLK_P, _pp("Speed", "01000", 7, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},JumpSpeed", "params": [JOB_P, BLK_P]}},

        {"name": "Marking Quality", "desc": "Set / get skip-cross/quality-level/wait-time",
         "wx": {"template": "WX,JOB={p0},BLK={p1},MarkingQuality={p2},{p3},{p4}",
                "params": [JOB_P, BLK_P, _pp("Skip Cross mm", "00.000", 8, "06.3f"),
                           _pp("Quality Level", "01", 4, "02d"),
                           _pp("Wait Time ms", "00000.0", 9, "07.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},MarkingQuality", "params": [JOB_P, BLK_P]}},

        {"name": "Approach", "desc": "Set / get approach distance",
         "wx": {"template": "WX,JOB={p0},BLK={p1},Approach={p2}",
                "params": [JOB_P, BLK_P, _pp("Approach mm", "0.000", 7, "05.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},Approach", "params": [JOB_P, BLK_P]}},

        {"name": "Space Approach", "desc": "Set / get space-approach distance",
         "wx": {"template": "WX,JOB={p0},BLK={p1},SpaceApproach={p2}",
                "params": [JOB_P, BLK_P, _pp("Approach mm", "0.000", 7, "05.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},SpaceApproach", "params": [JOB_P, BLK_P]}},

        {"name": "Curve Correction", "desc": "Set / get curve correction setting",
         "wx": {"template": "WX,JOB={p0},BLK={p1},CurveCorrection={p2}",
                "params": [JOB_P, BLK_P, _pp("Correction", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},CurveCorrection", "params": [JOB_P, BLK_P]}},
    ],

    # ==========================================================
    "Overprinting (OLP)": [
        {"name": "Multi-Pass Marking Parameter", "desc": "Set / get per-pass power/speed/deep-dig",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassMarkingParameter={p3},{p4},{p5},{p6},{p7},{p8},{p9}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Format", "0", 4, ""),
                           _pp("Power %", "050.0", 7, "05.1f"),
                           _pp("Speed mm/s", "01000", 7, "05d"),
                           _pp("Frequency kHz", "100", 5, "03d"),
                           _pp("Spot um", "0080", 6, "04d"),
                           _pp("Count", "001", 5, "03d"),
                           _pp("Deep Dig mm", "00.000", 8, "06.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassMarkingParameter",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Pattern", "desc": "Set / get per-pass 2D code pattern order",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassPattern={p3},{p4},{p5},{p6},{p7},{p8}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Pattern", "000", 5, "03d"), _pp("Finder", "000", 5, "03d"),
                           _pp("Alignment", "000", 5, "03d"), _pp("Cell", "000", 5, "03d"),
                           _pp("Order", "000", 5, "03d"), _pp("Count", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassPattern",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Fill Parameters", "desc": "Set / get per-pass fill interval/shrink",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassFillParameters={p3},{p4}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Fill Interval mm", "0.050", 7, "05.3f"),
                           _pp("Shrink Fill mm", "00.000", 8, "06.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassFillParameters",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Quality Level", "desc": "Set / get per-pass quality level",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassQualityLevel={p3}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Quality Level", "01", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassQualityLevel",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Approach", "desc": "Set / get per-pass approach distance",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassApproach={p3}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Approach mm", "0.000", 7, "05.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassApproach",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Space Approach", "desc": "Set / get per-pass space-approach distance",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassSpaceApproach={p3}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Approach mm", "0.000", 7, "05.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassSpaceApproach",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Curve Correction", "desc": "Set / get per-pass curve correction",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassCurveCorrection={p3}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Correction", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassCurveCorrection",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Jump Speed", "desc": "Set / get per-pass jump speed",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassJumpSpeed={p3}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Speed", "01000", 7, "")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassJumpSpeed",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},

        {"name": "Multi-Pass Block Marking Delay", "desc": "Set / get per-pass block delay time",
         "wx": {"template": "WX,JOB={p0},BLK={p1},OLP={p2},MultiPassBlockMarkingDelayTime={p3}",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, ""),
                           _pp("Time ms", "00000.0", 9, "07.1f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},OLP={p2},MultiPassBlockMarkingDelayTime",
                "params": [JOB_P, BLK_P, _pp("OLP Pass", "1", 4, "")]}},
    ],

    # ==========================================================
    "3D Shape": [
        {"name": "3D Shape (Block)", "desc": "Set / get whether a block uses a 3D shape",
         "wx": {"template": "WX,JOB={p0},BLK={p1},3DShape={p2},{p3}",
                "params": [JOB_P, BLK_P, _pp("Setting", "0", 4, ""),
                           _pp("Shape No (000-999)", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},3DShape", "params": [JOB_P, BLK_P]}},

        {"name": "3D Shape Type", "desc": "Set / get shape type for a 3D shape No.",
         "wx": {"template": "WX,JOB={p0},3DS={p1},3DShapeType={p2}",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d"),
                           _pp("Type", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},3DS={p1},3DShapeType",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d")]}},

        {"name": "3D Shape Position", "desc": "Set / get position + rotation of a 3D shape",
         "wx": {"template": "WX,JOB={p0},3DS={p1},3DShapePosition={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d"),
                           _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f"),
                           _pp("X-rot deg", "0000.000", 10, "08.3f"),
                           _pp("Y-rot deg", "0000.000", 10, "08.3f"),
                           _pp("Z-rot deg", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},3DS={p1},3DShapePosition",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d")]}},

        {"name": "Cylinder Diameter", "desc": "Set / get cylinder shape diameter",
         "wx": {"template": "WX,JOB={p0},3DS={p1},CylinderDiameter={p2}",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d"),
                           _pp("Diameter mm", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},3DS={p1},CylinderDiameter",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d")]}},

        {"name": "Cone Size", "desc": "Set / get cone shape dimensions",
         "wx": {"template": "WX,JOB={p0},3DS={p1},ConeSize={p2},{p3},{p4},{p5},{p6}",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d"),
                           _pp("Bottom Dia mm", "0000.000", 10, "08.3f"),
                           _pp("Bus Angle Enable", "0", 4, ""),
                           _pp("Top Dia mm", "0000.000", 10, "08.3f"),
                           _pp("Height mm", "000.000", 9, "07.3f"),
                           _pp("Bus Angle deg", "000.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},3DS={p1},ConeSize",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d")]}},

        {"name": "Sphere Diameter", "desc": "Set / get sphere shape diameter",
         "wx": {"template": "WX,JOB={p0},3DS={p1},SphereDiameter={p2}",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d"),
                           _pp("Diameter mm", "0000.000", 10, "08.3f")]},
         "rx": {"template": "RX,JOB={p0},3DS={p1},SphereDiameter",
                "params": [JOB_P, _pp("Shape No (000-999)", "000", 5, "03d")]}},

        {"name": "3D Surface Position", "desc": "Set / get a block's position on a 3D surface",
         "wx": {"template": "WX,JOB={p0},BLK={p1},3DSurfacePosition={p2},{p3},{p4}",
                "params": [JOB_P, BLK_P, _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Theta deg", "000.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},3DSurfacePosition", "params": [JOB_P, BLK_P]}},

        {"name": "Cone Setting", "desc": "Set / get cone char-frame/layout settings",
         "wx": {"template": "WX,JOB={p0},BLK={p1},ConeSetting={p2},{p3},{p4},{p5}",
                "params": [JOB_P, BLK_P, _pp("Char Frame", "0", 4, ""),
                           _pp("Layout", "0", 4, ""),
                           _pp("Angle Space deg", "000.000", 9, "07.3f"),
                           _pp("Open Angle deg", "000.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},BLK={p1},ConeSetting", "params": [JOB_P, BLK_P]}},
    ],

    # ==========================================================
    "Workflow": [
        {"name": "XY Tracking Enable", "desc": "Set / get whether a job uses XY tracking No.",
         "wx": {"template": "WX,JOB={p0},TRK={p1},XYTrackingEnable={p2}",
                "params": [JOB_P, _pp("TRK No (000-999)", "000", 6, "03d"),
                           _pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},TRK={p1},XYTrackingEnable",
                "params": [JOB_P, _pp("TRK No (000-999)", "000", 6, "03d")]}},

        {"name": "Z Tracking Enable", "desc": "Set / get whether a job uses Z tracking No.",
         "wx": {"template": "WX,JOB={p0},TRK={p1},ZTrackingEnable={p2}",
                "params": [JOB_P, _pp("TRK No (000-999)", "000", 6, "03d"),
                           _pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},TRK={p1},ZTrackingEnable",
                "params": [JOB_P, _pp("TRK No (000-999)", "000", 6, "03d")]}},

        {"name": "Z Tracking Calibration", "desc": "Set / get before/after values + temp change",
         "wx": {"template": "WX,JOB={p0},ZTrackingCalibration={p1},{p2},{p3}",
                "params": [JOB_P, _pp("Before", "0", 4, ""), _pp("After", "0", 4, ""),
                           _pp("Temp Change", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},ZTrackingCalibration", "params": [JOB_P]}},

        {"name": "XY Tracking Correction Threshold", "desc": "Set / get correction threshold",
         "wx": {"template": "WX,JOB={p0},TRK={p1},XYTrackingCorrectionThreshold={p2}",
                "params": [JOB_P, _pp("TRK No (000-999)", "000", 6, "03d"),
                           _pp("Threshold", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},TRK={p1},XYTrackingCorrectionThreshold",
                "params": [JOB_P, _pp("TRK No (000-999)", "000", 6, "03d")]}},

        {"name": "Window Check Before Marking - Enable", "desc": "Set / get enable flag",
         "wx": {"template": "WX,JOB={p0},WindowCheckBeforeMarkingEnable={p1}",
                "params": [JOB_P, _pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},WindowCheckBeforeMarkingEnable", "params": [JOB_P]}},
        {"name": "Window Check Before Marking - Alarm Threshold", "desc": "Set / get threshold",
         "wx": {"template": "WX,JOB={p0},WindowCheckBeforeMarkingAlarmThreshold={p1}",
                "params": [JOB_P, _pp("Threshold", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},WindowCheckBeforeMarkingAlarmThreshold", "params": [JOB_P]}},
        {"name": "Window Check Before Marking - Sensitivity", "desc": "Set / get sensitivity",
         "wx": {"template": "WX,JOB={p0},WindowCheckBeforeMarkingSensitivity={p1}",
                "params": [JOB_P, _pp("Sensitivity", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},WindowCheckBeforeMarkingSensitivity", "params": [JOB_P]}},

        {"name": "Window Check After Marking - Enable", "desc": "Set / get enable flag",
         "wx": {"template": "WX,JOB={p0},WindowCheckAfterMarkingEnable={p1}",
                "params": [JOB_P, _pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},WindowCheckAfterMarkingEnable", "params": [JOB_P]}},
        {"name": "Window Check After Marking - Alarm Threshold", "desc": "Set / get threshold",
         "wx": {"template": "WX,JOB={p0},WindowCheckAfterMarkingAlarmThreshold={p1}",
                "params": [JOB_P, _pp("Threshold", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},WindowCheckAfterMarkingAlarmThreshold", "params": [JOB_P]}},
        {"name": "Window Check After Marking - Sensitivity", "desc": "Set / get sensitivity",
         "wx": {"template": "WX,JOB={p0},WindowCheckAfterMarkingSensitivity={p1}",
                "params": [JOB_P, _pp("Sensitivity", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},WindowCheckAfterMarkingSensitivity", "params": [JOB_P]}},

        {"name": "Marking Confirmation Setting", "desc": "Set / get marking-confirmation camera check",
         "wx": {"template": "WX,JOB={p0},MarkingConfirmationSetting={p1},{p2},{p3},{p4},{p5}",
                "params": [JOB_P, _pp("Enable", "0", 4, ""),
                           _pp("Sensitivity Setting", "0", 4, ""),
                           _pp("Sensitivity", "000", 5, "03d"),
                           _pp("Error Threshold", "00000.0", 9, "08.1f"),
                           _pp("Capture Delay", "00000.0", 9, "08.1f")]},
         "rx": {"template": "RX,JOB={p0},MarkingConfirmationSetting", "params": [JOB_P]}},

        {"name": "Code Reader Setting", "desc": "Set / get code-reader enable/timing",
         "wx": {"template": "WX,JOB={p0},CodeReaderSetting={p1},{p2},{p3},{p4}",
                "params": [JOB_P, _pp("Enable", "0", 4, ""),
                           _pp("Capture Delay s", "0.0", 4, "01.1f"),
                           _pp("Hold Time s", "0.0", 5, "03.1f"),
                           _pp("Error Threshold", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},CodeReaderSetting", "params": [JOB_P]}},

        {"name": "Code Reader Light Setting", "desc": "Request code-reader light setting",
         "rx": {"template": "RX,JOB={p0},CodeReaderLightSetting", "params": [JOB_P]}},

        {"name": "Camera Imaging Setting", "desc": "Set / get zoom/brightness/gamma/light for a function No.",
         "wx": {"template": "WX,JOB={p0},FNC={p1},CameraImagingSetting={p2},{p3},{p4},{p5}",
                "params": [JOB_P, _pp("FNC No", "01", 4, "02d"),
                           _pp("Zoom", "1", 4, ""),
                           _pp("Brightness", "0000", 6, "04d"),
                           _pp("Gamma", "1.0", 5, "03.1f"),
                           _pp("Lighting Type", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},FNC={p1},CameraImagingSetting",
                "params": [JOB_P, _pp("FNC No", "01", 4, "02d")]}},

        {"name": "Camera Target Setting", "desc": "Set / get camera target position + tracking links",
         "wx": {"template": "WX,JOB={p0},FNC={p1},CameraTargetSetting={p2},{p3},{p4},{p5},{p6},{p7},{p8},{p9},{p10}",
                "params": [JOB_P, _pp("FNC No", "01", 4, "02d"),
                           _pp("Target Type", "0", 4, ""),
                           BLK_P if False else _pp("Block No (000-255)", "000", 6, "03d"),
                           _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f"),
                           _pp("Reflect XY", "0", 4, ""),
                           _pp("XY TRK No", "00", 4, "02d"),
                           _pp("Reflect Z", "0", 4, ""),
                           _pp("Z TRK No", "000", 5, "03d")]},
         "rx": {"template": "RX,JOB={p0},FNC={p1},CameraTargetSetting",
                "params": [JOB_P, _pp("FNC No", "01", 4, "02d")]}},

        {"name": "Workflow Result Detail 2", "desc": "Request last workflow result",
         "rx": {"template": "RX,WorkflowResultDetail2", "params": []}},
        {"name": "Marking Result", "desc": "Request last marking result",
         "rx": {"template": "RX,MarkingResult", "params": []}},
        {"name": "Window Check Before Marking Result", "desc": "Request last before-marking check result",
         "rx": {"template": "RX,WindowCheckBeforeMarkingResult", "params": []}},
        {"name": "Window Check After Marking Result", "desc": "Request last after-marking check result",
         "rx": {"template": "RX,WindowCheckAfterMarkingResult", "params": []}},
        {"name": "Camera Image File Path", "desc": "Request saved camera image file path",
         "rx": {"template": "RX,CameraImageFilePath={p0},{p1}",
                "params": [_pp("Target", "0", 4, ""), _pp("XY TRK No", "000", 5, "03d")]}},
        {"name": "Marking Confirmation Result", "desc": "Request last marking-confirmation result",
         "rx": {"template": "RX,MarkingConfirmationResult", "params": []}},
        {"name": "Code Read Result", "desc": "Request last code-read result",
         "rx": {"template": "RX,CodeReadResult={p0}",
                "params": [_pp("Acquire Detailed 0/1", "0", 4, "")]}},
        {"name": "Workflow Code Read Result", "desc": "Request workflow code-read result",
         "rx": {"template": "RX,WorkflowCodeReadResult={p0},{p1}",
                "params": [_pp("Select Result", "0", 4, ""),
                           _pp("Acquire Detailed 0/1", "0", 4, "")]}},
        {"name": "Marking Energy Result", "desc": "Request last marking-energy result",
         "rx": {"template": "RX,MarkingEnergyResult", "params": []}},
        {"name": "Matrix Cell Marking Count", "desc": "Request marked matrix cell count",
         "rx": {"template": "RX,MatrixCellMarkingCount", "params": []}},
    ],

    # ==========================================================
    "Matrix": [
        {"name": "Matrix Setting", "desc": "Set / get row/column count and direction",
         "wx": {"template": "WX,JOB={p0},MatrixSetting={p1},{p2},{p3}",
                "params": [JOB_P, _pp("Line Count", "001", 5, "03d"),
                           _pp("Col Count", "001", 5, "03d"),
                           _pp("Direction", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},MatrixSetting", "params": [JOB_P]}},

        {"name": "Matrix Size", "desc": "Set / get overall matrix height/width",
         "wx": {"template": "WX,JOB={p0},MatrixSize={p1},{p2},{p3},{p4}",
                "params": [JOB_P, _pp("Height Method", "0", 4, ""),
                           _pp("Height mm", "0.000", 9, "07.3f"),
                           _pp("Width Method", "0", 4, ""),
                           _pp("Width mm", "0.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},MatrixSize", "params": [JOB_P]}},

        {"name": "Cell Reference Point", "desc": "Set / get matrix cell reference point",
         "wx": {"template": "WX,JOB={p0},CellReferencePoint={p1}",
                "params": [JOB_P, _pp("Ref Point", "00", 4, "02d")]},
         "rx": {"template": "RX,JOB={p0},CellReferencePoint", "params": [JOB_P]}},

        {"name": "Matrix Cell", "desc": "Set / get an individual matrix cell",
         "wx": {"template": "WX,JOB={p0},CEL={p1},MatrixCell={p2},{p3},{p4},{p5},{p6},{p7}",
                "params": [JOB_P, _pp("Cell No (00001-65025)", "00001", 8, "05d"),
                           _pp("Mark Flag", "1", 4, ""),
                           _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "0000.000", 10, "08.3f"),
                           _pp("Z mm", "0000.000", 10, "08.3f"),
                           _pp("Theta deg", "0000.000", 10, "08.3f"),
                           _pp("Wait Time ms", "00000.0", 9, "07.1f")]},
         "rx": {"template": "RX,JOB={p0},CEL={p1},MatrixCell",
                "params": [JOB_P, _pp("Cell No (00001-65025)", "00001", 8, "05d")]}},

        {"name": "Matrix Cell Enable Flags", "desc": "Set which matrix cells are enabled",
         "wx": {"template": "WX,JOB={p0},CEL={p1},MatrixCellEnable={p2},{p3}",
                "params": [JOB_P, _pp("Cell No (00001-65025)", "00001", 8, "05d"),
                           _pp("Reset Flag", "0", 4, ""), _pp("Flags", "1", 10, "")]}},

        {"name": "Matrix Position", "desc": "Set / get matrix base point position",
         "wx": {"template": "WX,JOB={p0},MatrixPosition={p1},{p2},{p3}",
                "params": [JOB_P, _pp("Base Point", "00", 4, "02d"),
                           _pp("X mm", "0000.000", 10, "08.3f"),
                           _pp("Y mm", "000.000", 9, "07.3f")]},
         "rx": {"template": "RX,JOB={p0},MatrixPosition", "params": [JOB_P]}},

        {"name": "Inactive Cell Count", "desc": "Set / get number of inactive cells",
         "wx": {"template": "WX,JOB={p0},InactiveCellCount={p1}",
                "params": [JOB_P, _pp("Count", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},InactiveCellCount", "params": [JOB_P]}},
    ],

    # ==========================================================
    "Group / Counter": [
        {"name": "Group Offset", "desc": "Set / get position offset for a group No.",
         "wx": {"template": "WX,JOB={p0},GRP={p1},GroupOffset={p2},{p3},{p4},{p5}",
                "params": [JOB_P, _pp("Group No (000-999)", "000", 6, "03d"),
                           _pp("Shift X mm", "0000.000", 10, "08.3f"),
                           _pp("Shift Y mm", "0000.000", 10, "08.3f"),
                           _pp("Shift Theta deg", "0000.000", 10, "08.3f"),
                           _pp("Mark Flag", "1", 4, "")]},
         "rx": {"template": "RX,JOB={p0},GRP={p1},GroupOffset",
                "params": [JOB_P, _pp("Group No (000-999)", "000", 6, "03d")]}},

        {"name": "Counter Setting", "desc": "Set / get counter step/limits/reset behaviour",
         "wx": {"template": "WX,JOB={p0},CTR={p1},CounterSetting={p2},{p3},{p4},{p5},{p6},{p7},{p8},{p9}",
                "params": [JOB_P, _pp("Counter No (0-9/A-J)", "0", 4, ""),
                           _pp("Step", "00001", 7, "05d"),
                           _pp("Default Enable", "0", 4, ""),
                           _pp("Default Value", "0000000000", 12, "010d"),
                           _pp("Leading Value", "0000000000", 12, "010d"),
                           _pp("Final Value", "0000000000", 12, "010d"),
                           _pp("Mark Count", "0000000000", 12, "010d"),
                           _pp("Reset Timing", "0", 4, ""),
                           _pp("Count Timing", "0", 4, "")]},
         "rx": {"template": "RX,JOB={p0},CTR={p1},CounterSetting",
                "params": [JOB_P, _pp("Counter No (0-9/A-J)", "0", 4, "")]}},
    ],

    # ==========================================================
    "Operation Time": [
        {"name": "Operating Time", "desc": "Request controller operating time",
         "rx": {"template": "RX,OperatingTime", "params": []}},
        {"name": "Laser Operating Time", "desc": "Request laser-excited time",
         "rx": {"template": "RX,LaserOperatingTime", "params": []}},
        {"name": "Scanner Operating Time", "desc": "Request scanner operating time",
         "rx": {"template": "RX,ScannerOperatingTime", "params": []}},
        {"name": "Shutter Operating Count", "desc": "Request shutter operation count",
         "rx": {"template": "RX,ShutterOperatingCount", "params": []}},
        {"name": "Laser Safety Module Operating Count", "desc": "Request safety-module operation count",
         "rx": {"template": "RX,LaserSafetyModuleOperatingCount", "params": []}},
        {"name": "Marking Unit Temperature", "desc": "Request head temperature",
         "rx": {"template": "RX,MarkingUnitTemperature", "params": []}},
        {"name": "Controller Temperature", "desc": "Request controller temperature",
         "rx": {"template": "RX,ControllerTemperature", "params": []}},
        {"name": "Laser Power Calibration Result", "desc": "Request last calibration result",
         "rx": {"template": "RX,LaserPowerCalibrationResult", "params": []}},
        {"name": "Cumulative Marking Count", "desc": "Set / get cumulative marking counters",
         "wx": {"template": "WX,CumulativeMarkingCount={p0},{p1}",
                "params": [_pp("Count 1", "0000000000", 12, "010d"),
                           _pp("Count 2", "0000000000", 12, "010d")]},
         "rx": {"template": "RX,CumulativeMarkingCount", "params": []}},
    ],

    # ==========================================================
    "Maintenance": [
        {"name": "Lens Inspection (run)", "desc": "Execute lens inspection",
         "wx": {"template": "WX,WindowCheck", "params": []}},
        {"name": "Window Check Result", "desc": "Request lens inspection result",
         "rx": {"template": "RX,WindowCheckResult", "params": []}},
        {"name": "Window Check Sensitivity", "desc": "Set / get sensitivity 0=Std 1=High1 2=High2",
         "wx": {"template": "WX,WindowCheckSensitivity={p0}",
                "params": [_pp("0/1/2", "0", 4, "")]},
         "rx": {"template": "RX,WindowCheckSensitivity", "params": []}},
        {"name": "Window Check Startup", "desc": "Set / get run-lens-check-on-startup flag",
         "wx": {"template": "WX,WindowCheckStartup={p0}",
                "params": [_pp("0=OFF 1=ON", "0", 4, "")]},
         "rx": {"template": "RX,WindowCheckStartup", "params": []}},
        {"name": "Window Check Alarm Threshold", "desc": "Set / get lens-check alarm threshold",
         "wx": {"template": "WX,WindowCheckAlarmThreshold={p0}",
                "params": [_pp("Threshold", "000", 5, "03d")]},
         "rx": {"template": "RX,WindowCheckAlarmThreshold", "params": []}},

        {"name": "Laser Power Check", "desc": "Measure laser power (~10 sec)",
         "wx": {"template": "WX,LaserPowerCheck={p0},{p1}",
                "params": [_pp("Power% (000.0-100.0)", "050.0", 7, "05.1f"),
                           _pp("Freq kHz (000/040-400)", "100", 5, "03d")]}},

        {"name": "Start Laser Power Calibration", "desc": "Begin laser power calibration",
         "wx": {"template": "WX,StartLaserPowerCalibration={p0}",
                "params": [_pp("Calibration Type", "000", 5, "03d")]}},
        {"name": "Stop Laser Power Calibration", "desc": "Abort laser power calibration",
         "wx": {"template": "WX,StopLaserPowerCalibration", "params": []}},
        {"name": "Laser Power Calibration Status", "desc": "Request calibration progress/status",
         "rx": {"template": "RX,LaserPowerCalibrationStatus", "params": []}},

        {"name": "Advanced Laser Power Calibration", "desc": "Set / get an advanced-LPC entry",
         "wx": {"template": "WX,LPC={p0},AdvancedLaserPowerCalibration={p1},{p2},{p3},{p4},{p5}",
                "params": [_pp("LPC No (000-999)", "000", 6, "03d"),
                           _pp("Enable", "0", 4, ""),
                           _pp("Freq kHz", "100", 5, "03d"),
                           _pp("Min Power %", "000.0", 7, "05.1f"),
                           _pp("Max Power %", "100.0", 7, "05.1f"),
                           _pp("Pitch", "01.0", 7, "05.1f")]},
         "rx": {"template": "RX,LPC={p0},AdvancedLaserPowerCalibration",
                "params": [_pp("LPC No (000-999)", "000", 6, "03d")]}},

        {"name": "Sync Advanced Laser Power Calibration", "desc": "Set / get sync direction",
         "wx": {"template": "WX,SyncAdvancedLaserPowerCalibration={p0}",
                "params": [_pp("Direction", "0", 4, "")]},
         "rx": {"template": "RX,SyncAdvancedLaserPowerCalibration", "params": []}},

        {"name": "Reorder Advanced Laser Power Calibration", "desc": "Change priority order of an LPC entry",
         "wx": {"template": "WX,LPC={p0},ReorderAdvancedLaserPowerCalibration={p1}",
                "params": [_pp("LPC No (000-999)", "000", 6, "03d"),
                           _pp("Dest Priority", "000", 5, "03d")]}},

        {"name": "Delete Advanced Laser Power Calibration", "desc": "Delete LPC entries by priority (comma-sep)",
         "wx": {"template": "WX,DeleteAdvancedLaserPowerCalibration={p0}",
                "params": [_pp("Priorities e.g. 001,002", "001", 20, "")]}},

        {"name": "Logging - Clear All Data", "desc": "Erase all logged data",
         "wx": {"template": "WX,LoggingClearAllData", "params": []}},
        {"name": "Logging - Clear Data Range", "desc": "Erase logged data within a date range",
         "wx": {"template": "WX,LoggingClearData={p0},{p1}",
                "params": [_pp("Start Date (YYYYMMDDHH)", "0000000000", 12, "010d"),
                           _pp("End Date (YYYYMMDDHH)", "0000000000", 12, "010d")]}},
    ],
}


class LaserError(Exception):
    pass


# ----------------------------------------------------------------------
# Low-level socket client
# ----------------------------------------------------------------------
class LaserClient:
    def __init__(self, ip, port, timeout=30):
        self.ip = ip
        self.port = port
        self.timeout = timeout
        self.sock = None

    def connect(self):
        self.close()
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect((self.ip, self.port))
        self.sock = s

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def ensure_connected(self):
        if self.sock is None:
            self.connect()

    def _recv_until_delimiter(self, bufsize=4096, max_total=65536):
        buf = b""
        while DELIMITER not in buf:
            chunk = self.sock.recv(bufsize)
            if not chunk:
                raise ConnectionError("Connection closed by laser marker before delimiter received.")
            buf += chunk
            if len(buf) > max_total:
                raise ValueError("Response exceeded expected max length without delimiter.")
        return buf.decode("ascii", errors="replace").strip()

    def send_raw(self, command_str):
        self.ensure_connected()
        try:
            self.sock.sendall(f"{command_str}\r".encode("ascii"))
            return self._recv_until_delimiter()
        except (socket.timeout, ConnectionError, OSError):
            self.close()
            raise

    def send_with_retry(self, command_str, log_fn, max_wait=MAX_RETRY_WAIT, retry_delay=RETRY_DELAY):
        deadline = time.time() + max_wait
        attempt = 0
        while True:
            attempt += 1
            try:
                response = self.send_raw(command_str)
            except (socket.timeout, ConnectionError, OSError) as e:
                log_fn(f"    [warn] connection issue ({e}); reconnecting...")
                if time.time() > deadline:
                    raise LaserError(f"Timed out reconnecting to laser: {e}")
                time.sleep(retry_delay)
                continue

            if response.startswith("WX,OK"):
                return response

            if response.startswith("WX,NG"):
                if any(k.lower() in response.lower() for k in TRANSIENT_NG_KEYWORDS):
                    log_fn(f"    [retry {attempt}] laser busy ({response}), waiting...")
                    if time.time() > deadline:
                        raise LaserError(f"Gave up after {max_wait}s waiting for laser: {response}")
                    time.sleep(retry_delay)
                    continue
                raise LaserError(f"Laser returned error: {response}")

            raise LaserError(f"Unexpected response: {response}")

    def wait_until_ready(self, log_fn, max_wait=60, poll_interval=0.5):
        deadline = time.time() + max_wait
        while True:
            response = self.send_raw("RX,Ready")
            parts = response.split(",")
            if len(parts) >= 3 and parts[0] == "RX" and parts[1] == "OK":
                status = parts[2]
                if status == "0":
                    return
                elif status == "1":
                    raise LaserError("Laser marker has an active error (RX,Ready=1). "
                                     "Clear the error on the unit before continuing.")
                elif status == "2":
                    log_fn("    Laser busy (marking/expansion in progress), waiting...")
                else:
                    log_fn(f"    [warn] unexpected Ready status: {status}")
            else:
                log_fn(f"    [warn] unexpected Ready response: {response}")

            if time.time() > deadline:
                raise LaserError(f"Timed out after {max_wait}s waiting for laser to become READY.")
            time.sleep(poll_interval)

    def run_job(self, program_no, log_fn):
        job_str = f"{program_no:04d}"
        log_fn("  Waiting for laser to be READY...")
        self.wait_until_ready(log_fn)
        log_fn(f"  Selecting job {job_str}...")
        self.send_with_retry(f"WX,JobNo={job_str}", log_fn)
        log_fn(f"  Job {job_str} selected. Triggering marking...")
        time.sleep(0.2)
        self.send_with_retry("WX,StartMarking=1", log_fn)
        log_fn(f"  Job {job_str} marking complete.")


# ----------------------------------------------------------------------
# Parameter formatting helper for the Command Browser
# ----------------------------------------------------------------------
def format_param(raw_text, fmt):
    """
    Convert a raw text-entry value into the properly formatted token that
    belongs in the wire command, based on the format_spec (fmt) declared
    for that parameter (see COMMAND_GROUPS docstring above).
    Raises ValueError if the text can't be converted (caller shows this
    to the user rather than sending garbage to the laser).
    """
    raw_text = raw_text.strip()
    if not fmt:
        return raw_text
    kind = fmt[-1]
    if kind == "d":
        return format(int(raw_text), fmt)
    if kind == "f":
        return format(float(raw_text), fmt)
    # Fallback: try generic format, else return raw text unchanged.
    try:
        return format(raw_text, fmt)
    except (ValueError, TypeError):
        return raw_text


