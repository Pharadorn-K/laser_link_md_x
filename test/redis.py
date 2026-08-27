import json
import redis

# เชื่อมต่อ Redis Server (ระบุ host และ port ตามที่รันไว้)
r = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)

# ----------------------------------------------------
# รูปแบบที่ 1: เก็บแบบ JSON String (ยืดหยุ่น ซ้อน Dict ได้หลายชั้น)
# ----------------------------------------------------
system_store = {
    "currentAccName": "Operator_01",
    "currentAccId": 1001,
    "currentMode": "Auto",
    "JobListPallet1": {"jobId": "J-001", "partName": "AAA", "qty": 50},
    "JobListPallet2": {"jobId": "J-002", "partName": "BBB", "qty": 100},
}

# บันทึกลง Redis (แปลงเป็น JSON)
r.set("system_store", json.dumps(system_store))

# อ่านกลับมาใช้ใน Service อื่น
raw_data = r.get("system_store")
if raw_data:
    store = json.loads(raw_data)
    print("Mode:", store["currentMode"])
    print("Pallet 1 Job:", store["JobListPallet1"]["jobId"])


# ----------------------------------------------------
# รูปแบบที่ 2: เก็บแบบ Redis Hash (แยกอ่าน/แก้ไขเฉพาะ Field ได้ ไม่ต้องอัปเดตยกชุด)
# ----------------------------------------------------
# บันทึกข้อมูล
r.hset("current_user", "name", "John Doe")
r.hset("current_user", "role", "Admin")

# อัปเดตเฉพาะบาง Field
r.hset("current_user", "role", "SuperAdmin")

# ดึงเฉพาะ Field ที่ต้องการ
role = r.hget("current_user", "role")
print("User Role:", role)  # ผลลัพธ์: SuperAdmin