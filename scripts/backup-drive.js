/**
 * backup-drive.js
 * ---------------------------------------------------------------------------
 * Sau mỗi lần build.py chạy xong (3 lần/ngày), gửi toàn bộ data/raw_scores.json
 * lên Apps Script (xem apps-script/Code.gs) để tự tạo 1 file .xlsx đầy đủ điểm
 * thô từng buổi (Lecture) của mọi học viên, lưu vào thư mục Drive riêng
 * "iLearning Backups" (tự tạo nếu chưa có) — cùng cơ chế đã làm cho
 * thong-ke-diem-c-Learning.
 *
 * Cần 2 biến môi trường (lấy từ GitHub Secrets):
 *   ILEARNING_APPS_SCRIPT_URL   - URL Web app sau khi Deploy Code.gs
 *   ILEARNING_APPS_SCRIPT_TOKEN - Token bí mật khớp với Script Property WRITE_TOKEN
 * Xem hướng dẫn deploy chi tiết ở đầu file apps-script/Code.gs.
 *
 * Nếu chưa cấu hình 2 biến trên, script tự bỏ qua (không làm hỏng workflow
 * chính) — để backup là tính năng optional, bật lên khi nào sẵn sàng.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const RAW_SCORES_PATH = path.join(ROOT, "data", "raw_scores.json");
const BRANCH_MAP_PATH = path.join(ROOT, "data", "branch_region_map.json");
const CLASS_CALENDAR_PATH = path.join(ROOT, "data", "class_calendar.json");

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function todayStringVN() {
  // Asia/Ho_Chi_Minh (UTC+7), dạng YYYY-MM-DD — khớp định dạng ngày trong
  // data/class_calendar.json.
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Port lại đúng logic xác định "lớp đã dạy tới buổi mấy" trong
// scripts/build.py (hàm build_legacy_stats): ưu tiên NGÀY DẠY THẬT từ
// data/class_calendar.json, fallback qua "lecture xa nhất có điểm khác rỗng"
// cho lớp chưa có lịch. Kết quả được ghi thẳng vào file backup (cột "Buổi đã
// dạy tới") để lúc upload lại lên dashboard, tab Thống kê tính % CHÍNH XÁC
// như dashboard tự động — không phải đoán qua điểm nữa.
function computeClassMaxReached(rawRows, classCalendars) {
  const todayStr = todayStringVN();
  const classMaxReached = {};
  const classesUsingFallback = new Set();

  for (const row of rawRows) {
    const classCode = String(row.Class || "").trim();
    const branch = String(row.Branch || "").trim();
    if (!classCode) continue;
    const key = `${branch}||${classCode}`;
    if (key in classMaxReached) continue;
    const calendar = classCalendars[key];
    if (calendar) {
      let reached = 0;
      for (const [lecStr, date] of Object.entries(calendar)) {
        if (date && date <= todayStr) {
          const lec = parseInt(lecStr, 10);
          if (lec > reached) reached = lec;
        }
      }
      classMaxReached[key] = reached;
    } else {
      classesUsingFallback.add(key);
    }
  }

  if (classesUsingFallback.size) {
    for (const row of rawRows) {
      const classCode = String(row.Class || "").trim();
      const branch = String(row.Branch || "").trim();
      const key = `${branch}||${classCode}`;
      if (!classesUsingFallback.has(key)) continue;
      const lectures = row.lectures || {};
      for (const [lecNoStr, activities] of Object.entries(lectures)) {
        const hasAnyScore = Object.entries(activities || {}).some(
          ([actName, score]) => actName !== "_lessonName" && score !== "" && score !== null && score !== undefined
        );
        if (!hasAnyScore) continue;
        const lecNo = parseInt(lecNoStr, 10);
        if (lecNo > (classMaxReached[key] || 0)) classMaxReached[key] = lecNo;
      }
    }
  }

  return classMaxReached;
}

// Gộp các hoạt động (trừ "_lessonName") của 1 buổi thành 1 chuỗi dễ đọc, dạng
// "i-Build=100 | i-Imagine=100 | i-Read=90" — vừa xem được bằng mắt trong Excel,
// vừa parse ngược lại được (dùng chung ở nút "Tải file backup" trên dashboard).
// QUAN TRỌNG: hoạt động CHƯA có điểm vẫn được giữ lại (dạng "i-Build=", không
// có giá trị sau dấu =) thay vì bỏ qua hẳn — nếu bỏ qua, khi tải file backup
// lên dashboard sẽ không biết hoạt động đó có TỒN TẠI hay không, làm sai lệch
// % hoàn thành tính lại ở tab Thống kê (nhầm "chưa chấm" thành "không có").
function formatActivities(activities) {
  const parts = [];
  for (const [key, value] of Object.entries(activities || {})) {
    if (key === "_lessonName") continue;
    if (value === "" || value === null || value === undefined) {
      parts.push(`${key}=`);
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  return parts.join(" | ");
}

function buildHeadersAndRows(rawRows, branchRegionMap, classMaxReached) {
  let maxLecture = 0;
  for (const row of rawRows) {
    for (const lecNoStr of Object.keys(row.lectures || {})) {
      const n = parseInt(lecNoStr, 10);
      if (!Number.isNaN(n) && n > maxLecture) maxLecture = n;
    }
  }

  const headers = ["Vùng", "Chi nhánh", "Program", "Syllabus", "Lớp", "Mã học viên", "Tên học viên", "Buổi đã dạy tới"];
  for (let n = 1; n <= maxLecture; n++) {
    headers.push(`Buổi ${n} - Bài học`, `Buổi ${n} - Điểm`);
  }

  const rows = rawRows.map(row => {
    const branch = String(row.Branch || "").trim();
    const classCode = row.Class || "";
    const region = branchRegionMap[branch] || "Chưa xác định";
    const maxReached = classMaxReached[`${branch}||${classCode}`] || 0;
    const out = [
      region, branch, row.Program || "", row.Syllabus || "", classCode,
      String(row.ID ?? ""), row.Name || "", maxReached,
    ];
    const lectures = row.lectures || {};
    for (let n = 1; n <= maxLecture; n++) {
      const activities = lectures[String(n)] || {};
      out.push(activities._lessonName || "", formatActivities(activities));
    }
    return out;
  });

  return { headers, rows };
}

async function main() {
  const url = process.env.ILEARNING_APPS_SCRIPT_URL;
  const token = process.env.ILEARNING_APPS_SCRIPT_TOKEN;

  if (!url || !token) {
    console.log("[backup-drive] Chưa cấu hình ILEARNING_APPS_SCRIPT_URL / ILEARNING_APPS_SCRIPT_TOKEN -> bỏ qua backup.");
    return;
  }

  const rawRows = loadJson(RAW_SCORES_PATH, []);
  if (!rawRows.length) {
    console.log("[backup-drive] data/raw_scores.json rỗng -> bỏ qua backup.");
    return;
  }
  const branchRegionMap = loadJson(BRANCH_MAP_PATH, {});
  const classCalendars = loadJson(CLASS_CALENDAR_PATH, {});
  const classMaxReached = computeClassMaxReached(rawRows, classCalendars);

  const { headers, rows } = buildHeadersAndRows(rawRows, branchRegionMap, classMaxReached);
  console.log(`[backup-drive] Chuẩn bị gửi ${rows.length} dòng, ${headers.length} cột lên Apps Script...`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, headers, rows }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Apps Script trả về nội dung không phải JSON (status ${res.status}): ${text.slice(0, 500)}`);
  }

  if (!json.ok) {
    throw new Error(`Backup thất bại: ${json.error || "không rõ lỗi"}`);
  }

  console.log(`[backup-drive] Backup thành công: ${json.rowCount} dòng. Folder Drive: ${json.backupFolderUrl || "(không rõ URL)"}`);
}

main().catch(err => {
  console.error("[backup-drive] Lỗi:", err.message || err);
  process.exit(1);
});
