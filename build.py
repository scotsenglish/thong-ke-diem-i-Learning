"""
build.py
-------------------------------------------------------------------------
Đọc data/raw_scores.json (do scrape.js tạo ra) + data/branch_region_map.json
(bảng map Chi nhánh -> Vùng, bạn tự duy trì) -> nhúng vào template.html
-> xuất ra index.html để publish qua GitHub Pages.

Chạy: python3 scripts/build.py
-------------------------------------------------------------------------
"""

import json
import os
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
RAW_SCORES_PATH = os.path.join(DATA_DIR, "raw_scores.json")
BRANCH_MAP_PATH = os.path.join(DATA_DIR, "branch_region_map.json")
TEMPLATE_PATH = os.path.join(ROOT, "template.html")
OUTPUT_PATH = os.path.join(ROOT, "dashboard.html")  # index.html giờ là trang chờ (landing page) tĩnh, không phải output của build.py


def load_json(path, default):
    if not os.path.exists(path):
        print(f"[CẢNH BÁO] Không tìm thấy {path}, dùng giá trị mặc định.")
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_student_dict(raw_rows, branch_region_map):
    """
    raw_rows: list các dict dạng
        { Branch, Program, Syllabus, Class, ID, Name, lectures: {"1": {...}, "2": {...}} }
    Trả về dict khóa theo ID học viên, giá trị là object dùng cho dashboard.

    Lưu ý: vì mỗi dòng trong file gốc = 1 học viên trong 1 lớp, nếu 1 học viên
    ID xuất hiện ở nhiều lớp (VD học lại / học nhiều khóa), ta gộp theo
    key = ID + Class để tránh ghi đè dữ liệu của lớp khác.
    """
    students = {}
    missing_region_branches = set()

    for row in raw_rows:
        sid_raw = str(row.get("ID", "")).strip()
        class_code = str(row.get("Class", "")).strip()
        if not sid_raw or not class_code:
            continue

        # Key duy nhất: 1 học viên có thể học nhiều lớp -> mỗi lớp là 1 entry riêng
        key = f"{sid_raw}::{class_code}"

        branch = str(row.get("Branch", "")).strip()
        region = branch_region_map.get(branch)
        if region is None:
            region = "Chưa xác định"
            missing_region_branches.add(branch)

        # Chuẩn hóa lectures: key JSON là string "1","2"... -> ép về int khi build.
        # Mỗi lecture giờ tách riêng "lesson" (tên bài học, dạng text) và "scores"
        # (điểm từng thành phần, dạng số) — vì scrape.js lưu tên bài học chung
        # trong key đặc biệt "_lessonName" lẫn cùng chỗ với điểm số.
        lectures_raw = row.get("lectures", {}) or {}
        lectures = {}
        for lec_no_str, activities in lectures_raw.items():
            try:
                lec_no = int(lec_no_str)
            except (TypeError, ValueError):
                continue
            activities = activities or {}
            lesson_name = activities.get("_lessonName", "")
            clean_activities = {}
            for act_name, score in activities.items():
                if act_name == "_lessonName":
                    continue
                if score == "" or score is None:
                    continue
                try:
                    clean_activities[act_name] = float(score)
                except (TypeError, ValueError):
                    continue
            if clean_activities or lesson_name:
                lectures[lec_no] = {"lesson": lesson_name, "scores": clean_activities}

        students[key] = {
            "id": sid_raw,
            "name": row.get("Name", ""),
            "branch": branch,
            "region": region,
            "program": row.get("Program", ""),
            "syllabus": row.get("Syllabus", ""),
            "classCode": class_code,
            "lectures": lectures
        }

    if missing_region_branches:
        print("[CẢNH BÁO] Các chi nhánh sau chưa có trong branch_region_map.json:")
        for b in sorted(missing_region_branches):
            print(f"  - {b}")
        print("  -> Bổ sung vào data/branch_region_map.json rồi build lại để hiện đúng Vùng.")

    return students


def main():
    raw_rows = load_json(RAW_SCORES_PATH, [])
    branch_region_map = load_json(BRANCH_MAP_PATH, {})

    if not raw_rows:
        print("[LỖI] data/raw_scores.json rỗng hoặc không tồn tại. Dừng build.")
        return

    students = build_student_dict(raw_rows, branch_region_map)
    print(f"Đã build {len(students)} dòng học viên-lớp.")

    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        template = f.read()

    students_json = json.dumps(students, ensure_ascii=False)
    output_html = template.replace("__STUDENT_DATA__", students_json)

    build_time_vn = datetime.now(timezone(timedelta(hours=7))).strftime("%H:%M %d/%m/%Y")
    output_html = output_html.replace("__BUILD_TIME__", build_time_vn)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(output_html)

    print(f"Đã ghi {OUTPUT_PATH} ({len(output_html):,} ký tự).")


if __name__ == "__main__":
    main()
