/**
 * scrape.js
 * ---------------------------------------------------------------------------
 * Tự động: đăng nhập LMS -> build Class Plan + Class ID Cache -> export điểm
 * raw i-Learning theo từng lecture -> ghi ra data/raw_scores.json
 *
 * Chạy: node scripts/scrape.js
 * Cần 2 biến môi trường: LMS_LOGIN_ID, LMS_LOGIN_PASSWORD (đặt trong GitHub
 * Actions Secrets, KHÔNG hardcode vào file này).
 * ---------------------------------------------------------------------------
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// LƯU Ý QUAN TRỌNG: khi GitHub hủy 1 job từ bên ngoài (timeout, abuse-detection,
// hay bất kỳ lý do gì), nó hủy NGUYÊN CẢ JOB ngay lập tức — không bước nào sau
// đó (kể cả bước "Commit & push") kịp chạy. Vì vậy checkpoint không thể chỉ ghi
// xuống đĩa tạm của runner; phải TỰ commit + push lên GitHub ngay trong lúc
// đang chạy, mỗi lần checkpoint, để tiến độ được lưu thật sự an toàn.

// Tổ chức GitHub của bạn giới hạn cứng 90 phút/job (không sửa được từ workflow).
// Đặt ngưỡng nội bộ thấp hơn hẳn để KỊP tự dừng có kiểm soát, lưu lại tiến độ,
// và nhường phần còn lại cho lần chạy kế tiếp (6h/12h/18h) tiếp tục — thay vì
// bị GitHub giết đột ngột giữa chừng (mất khả năng lưu trạng thái sạch sẽ).
const TIME_BUDGET_MS = 320 * 60 * 1000; // 320 phút cho phần cào điểm — chừa ~40 phút buffer cho setup/login/build/commit trong tổng trần 360 phút
const CACHE_BUILD_BUDGET_MS = 20 * 60 * 1000; // 20 phút cho phần build Class ID Cache (chỉ chạy ở vòng quét mới)

const LOGIN_URL = "https://lms.scotsenglish.edu.vn/login.html";
const BASE = "https://lms.scotsenglish.edu.vn/data/setup.asmx";
const STAFF_ID = 9072;

// Lấy nguyên từ script "Auto Export Class Plan + Class ID Cache" bạn cung cấp.
// Khi có chi nhánh mới, chỉ cần thêm dòng vào đây.
const BRANCHES = [
  { brch_id: 362, brch_name: "Scots English An Khánh" },
  { brch_id: 387, brch_name: "Scots English Bắc Giang" },
  { brch_id: 382, brch_name: "Scots English Bắc Ninh" },
  { brch_id: 384, brch_name: "Scots English Bắc Ninh 2" },
  { brch_id: 373, brch_name: "Scots English Celadon - Tân Phú" },
  { brch_id: 370, brch_name: "Scots English Đà Nẵng" },
  { brch_id: 371, brch_name: "Scots English Đà Nẵng 2" },
  { brch_id: 366, brch_name: "Scots English Định Công" },
  { brch_id: 361, brch_name: "Scots English Dương Nội" },
  { brch_id: 379, brch_name: "Scots English Hải Dương" },
  { brch_id: 385, brch_name: "Scots English Hải Phòng" },
  { brch_id: 386, brch_name: "Scots English Hải Phòng 2" },
  { brch_id: 353, brch_name: "Scots English Hoàng Đạo Thúy" },
  { brch_id: 348, brch_name: "Scots English Hoàng Quốc Việt" },
  { brch_id: 356, brch_name: "Scots English Kim Giang" },
  { brch_id: 357, brch_name: "Scots English Linh Đàm" },
  { brch_id: 360, brch_name: "Scots English Long Biên" },
  { brch_id: 352, brch_name: "Scots English Mỹ Đình" },
  { brch_id: 358, brch_name: "Scots English Nguyễn Tuân" },
  { brch_id: 359, brch_name: "Scots English Nguyễn Xiển" },
  { brch_id: 365, brch_name: "Scots English Ocean Park" },
  { brch_id: 374, brch_name: "Scots English Phạm Văn Chiêu" },
  { brch_id: 363, brch_name: "Scots English Phạm Văn Đồng" },
  { brch_id: 372, brch_name: "Scots English Phan Văn Trị" },
  { brch_id: 377, brch_name: "Scots English Phúc Yên" },
  { brch_id: 350, brch_name: "Scots English Sài Đồng" },
  { brch_id: 355, brch_name: "Scots English Tây Hồ" },
  { brch_id: 381, brch_name: "Scots English Thái Bình" },
  { brch_id: 369, brch_name: "Scots English Thanh Hóa" },
  { brch_id: 351, brch_name: "Scots English Times City" },
  { brch_id: 368, brch_name: "Scots English Trung Văn" },
  { brch_id: 364, brch_name: "Scots English Trường Chinh" },
  { brch_id: 383, brch_name: "Scots English Từ Sơn" },
  { brch_id: 354, brch_name: "Scots English Văn Khê" },
  { brch_id: 380, brch_name: "Scots English Việt Trì" },
  { brch_id: 388, brch_name: "Scots English Vinh" },
  { brch_id: 376, brch_name: "Scots English Vĩnh Phúc" },
  { brch_id: 378, brch_name: "Scots English Vĩnh Phúc 3" },
  { brch_id: 367, brch_name: "Scots English Vinhomes Gardenia" },
  { brch_id: 349, brch_name: "Scots English Vinhomes Smart City" },
  { brch_id: 375, brch_name: "Scots English Vinhomes Smart City 2" }
];

// Lấy dư ra để không bỏ sót lecture mới phát sinh; script tự lọc theo lecture
// thực sự đã được tạo trên LMS (qua CounRptLectureList), nên đặt cao không tốn
// thêm request thừa.
const LECTURE_FROM = 1;
const LECTURE_TO = 60;

async function main() {
  const loginId = process.env.LMS_LOGIN_ID;
  const loginPassword = process.env.LMS_LOGIN_PASSWORD;
  if (!loginId || !loginPassword) {
    throw new Error("Thiếu biến môi trường LMS_LOGIN_ID / LMS_LOGIN_PASSWORD");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  // LMS có thể hiện alert() báo sai tài khoản/mật khẩu — bắt lại để log ra,
  // tránh Playwright bị treo chờ vô thời hạn vì dialog chưa được xử lý
  page.on("dialog", async dialog => {
    console.log(`[DIALOG từ trang] ${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });

  console.log("== Đăng nhập LMS ==");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#login_id", { state: "visible" });
  await page.fill("#login_id", loginId);
  await page.fill("#login_password", loginPassword);
  await page.click("#btn_login");

  try {
    // Đợi rời khỏi trang login (Angular xử lý login() rồi điều hướng đi nơi khác)
    await page.waitForFunction(() => !location.href.includes("login.html"), {
      timeout: 60000
    });
    console.log("Đăng nhập OK. URL hiện tại:", page.url());
  } catch (err) {
    // Không đăng nhập được -> chụp lại màn hình + HTML tại thời điểm lỗi để debug,
    // vì không thể xem trực tiếp máy chạy Actions
    console.log("== ĐĂNG NHẬP THẤT BẠI — đang lưu ảnh chụp + HTML để debug ==");
    const debugDir = path.join(__dirname, "..", "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, "login-failed.png"), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(debugDir, "login-failed.html"), await page.content().catch(() => "(không lấy được HTML)"));
    console.log("Đã lưu debug/login-failed.png và debug/login-failed.html");
    console.log("URL tại thời điểm lỗi:", page.url());
    await browser.close();
    throw err;
  }

  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const statePath = path.join(outDir, "scrape_state.json");
  const rawScoresPath = path.join(outDir, "raw_scores.json");

  function loadJsonSafe(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return fallback;
    }
  }

  const prevState = loadJsonSafe(statePath, null);
  const isResuming = !!(prevState && prevState.status === "in_progress" && Array.isArray(prevState.remainingClasses) && prevState.remainingClasses.length > 0);

  const repoRoot = path.join(__dirname, "..");
  function gitCheckpointCommit(message) {
    try {
      execSync("git add data/raw_scores.json data/run_log.json data/scrape_state.json data/class_calendar.json", { cwd: repoRoot, stdio: "pipe" });
      // Nếu không có gì thay đổi thì bỏ qua commit (tránh lỗi "nothing to commit")
      const hasChanges = execSync("git diff --cached --name-only", { cwd: repoRoot }).toString().trim().length > 0;
      if (!hasChanges) return;
      execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { cwd: repoRoot, stdio: "pipe" });
      execSync("git push", { cwd: repoRoot, stdio: "pipe" });
    } catch (err) {
      // Không để lỗi git làm crash cả tiến trình cào dữ liệu — chỉ log lại để biết
      console.log("[CẢNH BÁO] Commit/push checkpoint thất bại:", String(err?.message ?? err).slice(0, 300));
    }
  }

  let classesForCycle;
  let allStudents;
  let allErrors = [];
  let allCalendars;  // classCode -> { lectureNo: "YYYY-MM-DD" } — ngày dạy thật của từng lecture
  let totalClassesInCycle = 0;
  const classCalendarPath = path.join(__dirname, "..", "data", "class_calendar.json");

  if (isResuming) {
    console.log(`== Đang TIẾP TỤC vòng quét dang dở: còn ${prevState.remainingClasses.length} lớp (bắt đầu vòng lúc ${prevState.cycleStartedAt}) ==`);
    classesForCycle = prevState.remainingClasses;
    allStudents = loadJsonSafe(rawScoresPath, []); // dữ liệu đã cào được ở các lần chạy trước trong vòng này
    allCalendars = loadJsonSafe(classCalendarPath, {});
    totalClassesInCycle = prevState.totalClassesInCycle || prevState.remainingClasses.length;
  }

  // ================= BƯỚC 1: Class Plan + Class ID Cache =================
  // Chỉ build lại danh sách lớp khi bắt đầu 1 VÒNG QUÉT MỚI (không phải đang
  // tiếp tục vòng dang dở), để giữ nguyên tập lớp xuyên suốt 1 vòng.
  let step1 = { cacheRows: [], errorRows: [] };
  if (!isResuming) {
    console.log("== Đang build Class Plan + Class ID Cache (vòng quét mới) ==");
    step1 = await page.evaluate(
    async ({ BASE, STAFF_ID, BRANCHES, deadline }) => {
      const normalize = v =>
        String(v ?? "")
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ");

      async function post(endpoint, body, attempt = 1) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 25000);
          let res;
          try {
            res = await fetch(`${BASE}/${endpoint}`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json;charset=UTF-8" },
              body: JSON.stringify(body),
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeoutId);
          }
          const text = await res.text();
          if ([502, 503, 504].includes(res.status) && attempt < 3) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
            return post(endpoint, body, attempt + 1);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
          const json = JSON.parse(text);
          if (!json?.d?.result) return [];
          return JSON.parse(json.d.result).Table || [];
        } catch (err) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
            return post(endpoint, body, attempt + 1);
          }
          throw err;
        }
      }

      const classPlanMap = new Map();
      const cacheRows = [];
      const errorRows = [];
      const seenCache = new Set();
      let stoppedEarly = false;

      for (const branch of BRANCHES) {
        if (Date.now() >= deadline) {
          stoppedEarly = true;
          errorRows.push({ Branch: branch.brch_name, Step: "Deadline", Error: "Chưa xử lý do hết thời gian nội bộ build cache" });
          continue;
        }
        try {
          const semesters = await post("CounSemester", {
            staff: { stf_id: STAFF_ID },
            setup: { hr_brch_id: branch.brch_id }
          });
          const bsemId = semesters?.[0]?.bsem_id;
          if (!bsemId) {
            errorRows.push({ Branch: branch.brch_name, Step: "CounSemester", Error: "No bsem_id" });
            continue;
          }

          const statClasses = await post("reportStaticsClassList", {
            ret: { rt_brch_id: branch.brch_id, rt_bsem_id: bsemId, rt_cors_id: 0, rt_syl_id: 0 }
          });
          for (const c of statClasses) {
            const planBranch = c.brch_name ?? branch.brch_name;
            const className = c.cls_name ?? "";
            if (!className) continue;
            const key = `${normalize(planBranch)}|${normalize(className)}`;
            const planRow = {
              Branch: planBranch,
              Program: c.top_cors_name ?? "",
              Level: c.clevel_name ?? "",
              Syllabus: c.syl_name ?? "",
              Class: className,
              "Start Date": c.cls_startdate ?? "",
              bsem_id: bsemId,
              brch_id: branch.brch_id
            };
            if (!classPlanMap.has(key)) classPlanMap.set(key, planRow);
            else if (!classPlanMap.get(key)["Start Date"] && planRow["Start Date"]) classPlanMap.set(key, planRow);
          }

          const programs = await post("CounStudentClassProgram", { counn: { coun_bsem_id: bsemId } });
          for (const program of programs) {
            const corsId = program.id ?? program.cors_id ?? "";
            const programName = program.name ?? program.cors_name ?? "";
            if (!corsId) continue;

            const syllabuses = await post("CounStudentClassSyllabus", {
              counn: { coun_bsem_id: bsemId, coun_cors_id: corsId }
            });
            for (const syl of syllabuses) {
              const sylId = syl.syl_id ?? "";
              const sylName = syl.syl_name ?? "";
              if (!sylId) continue;

              const classes = await post("CounRptStudentClassList", {
                counn: { coun_bsem_id: bsemId, coun_syl_id: sylId, coun_cls_isclosed: 0 }
              });
              for (const cls of classes) {
                const className = cls.cls_name ?? "";
                const clsId = cls.cls_id ?? "";
                if (!className || !clsId) continue;
                const cacheKey = [branch.brch_id, bsemId, corsId, sylId, clsId].join("||");
                if (seenCache.has(cacheKey)) continue;
                seenCache.add(cacheKey);

                const planKey = `${normalize(branch.brch_name)}|${normalize(className)}`;
                const plan = classPlanMap.get(planKey);
                cacheRows.push({
                  Branch: branch.brch_name,
                  Class: className,
                  brch_id: branch.brch_id,
                  bsem_id: bsemId,
                  cors_id: corsId,
                  syl_id: sylId,
                  cls_id: clsId,
                  Program_LMS: programName,
                  Syllabus_LMS: sylName,
                  Program_From_Plan: plan?.Program ?? "",
                  Syllabus_From_Plan: plan?.Syllabus ?? ""
                });
              }
            }
          }
        } catch (err) {
          errorRows.push({ Branch: branch.brch_name, Step: "Branch Loop", Error: String(err?.message ?? err) });
        }
      }

      return { cacheRows, errorRows, stoppedEarly };
    },
    { BASE, STAFF_ID, BRANCHES, deadline: Date.now() + CACHE_BUILD_BUDGET_MS }
  );

    if (step1.stoppedEarly) {
      console.log(`[CẢNH BÁO] Build Class ID Cache bị dừng sớm do quá ${CACHE_BUILD_BUDGET_MS / 60000} phút — 1 số chi nhánh có thể chưa được quét đủ trong vòng này.`);
    }

    console.log(`Class ID Cache: ${step1.cacheRows.length} lớp. Lỗi: ${step1.errorRows.length}`);

    classesForCycle = step1.cacheRows;
    allStudents = []; // vòng quét mới -> làm lại từ đầu, không giữ dữ liệu vòng cũ
    allCalendars = {};
    totalClassesInCycle = classesForCycle.length;

    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          status: "in_progress",
          cycleStartedAt: new Date().toISOString(),
          totalClassesInCycle,
          remainingClasses: classesForCycle,
          cacheErrors: step1.errorRows
        },
        null,
        2
      )
    );
  }

  // ================= Chuẩn bị ghi checkpoint + output =================
  function saveOutputs(students, errors, calendars, meta) {
    fs.writeFileSync(path.join(outDir, "raw_scores.json"), JSON.stringify(students));
    fs.writeFileSync(path.join(outDir, "class_calendar.json"), JSON.stringify(calendars));
    fs.writeFileSync(
      path.join(outDir, "run_log.json"),
      JSON.stringify(
        {
          run_at: new Date().toISOString(),
          classes_total: totalClassesInCycle,
          cache_errors: step1.errorRows,
          students_total: students.length,
          score_errors: errors,
          ...meta
        },
        null,
        2
      )
    );
  }

  // Node expose ra 1 hàm để phía trình duyệt (page.evaluate) gọi ngược lại,
  // gửi về PHẦN MỚI vừa xử lý xong (không phải toàn bộ), Node gộp dồn lại rồi
  // ghi checkpoint xuống đĩa ngay -> phía trình duyệt xóa sạch bộ nhớ đã gửi,
  // tránh tích lũy dữ liệu khổng lồ trong RAM của tab Chrome gây bị kill giữa chừng.
  // Đồng thời cập nhật luôn file trạng thái resume (còn lại bao nhiêu lớp),
  // để nếu bị kill đột ngột thì lần chạy sau vẫn biết chính xác cần làm tiếp từ đâu.
  await context.exposeFunction("__saveCheckpoint", (newStudentsBatch, newErrorsBatch, newCalendarBatch, done, total) => {
    allStudents = allStudents.concat(newStudentsBatch);
    allErrors = allErrors.concat(newErrorsBatch);
    Object.assign(allCalendars, newCalendarBatch);
    saveOutputs(allStudents, allErrors, allCalendars, {
      checkpoint: true,
      progress: `${done}/${total}`
    });
    // Cập nhật state resume: những lớp từ vị trí `done` trở đi trong classesForCycle
    // là phần CHƯA xử lý xong -> lưu lại để lần chạy sau (nếu bị kill) tiếp tục đúng chỗ.
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          status: "in_progress",
          cycleStartedAt: prevState?.cycleStartedAt || new Date().toISOString(),
          totalClassesInCycle,
          remainingClasses: classesForCycle.slice(done),
          cacheErrors: step1.errorRows
        },
        null,
        2
      )
    );
    console.log(`[Checkpoint] Đã lưu tạm ${allStudents.length} dòng học viên (${done}/${total} lớp).`);

    // QUAN TRỌNG: commit + push NGAY, không đợi tới cuối job — vì job có thể bị
    // hủy đột ngột bất cứ lúc nào sau đây, và dữ liệu chỉ nằm trên đĩa runner
    // (chưa push) sẽ mất trắng nếu không làm bước này ở đây.
    gitCheckpointCommit(`Checkpoint tự động: ${done}/${total} lớp (${allStudents.length} dòng học viên)`);
  });

  // ================= BƯỚC 2: Export điểm raw theo lecture =================
  const deadline = Date.now() + TIME_BUDGET_MS;
  console.log(`== Đang export điểm raw i-Learning (giới hạn nội bộ ${TIME_BUDGET_MS / 60000} phút cho phần này) ==`);
  let step2;
  try {
    step2 = await page.evaluate(
      async ({ BASE, classes, LECTURE_FROM, LECTURE_TO, deadline }) => {
        const CONCURRENCY = 3;
        const REQUEST_DELAY_MS = 150;
        const CHECKPOINT_EVERY = 50;
        const activityOrder = ["i-Build", "i-Read", "i-Listen", "i-Imagine", "i-Create", "i-Boost"];
        const sleep = ms => new Promise(r => setTimeout(r, ms));

      async function post(endpoint, body, attempt = 1) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 25000);
          let res;
          try {
            res = await fetch(`${BASE}/${endpoint}`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json;charset=UTF-8" },
              body: JSON.stringify(body),
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeoutId);
          }
          const text = await res.text();
          if ([502, 503, 504].includes(res.status) && attempt < 3) {
            await sleep(1000 * attempt);
            return post(endpoint, body, attempt + 1);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
          const json = JSON.parse(text);
          if (!json?.d?.result) return [];
          return JSON.parse(json.d.result).Table || [];
        } catch (err) {
          if (attempt < 3) {
            await sleep(1000 * attempt);
            return post(endpoint, body, attempt + 1);
          }
          throw err;
        }
      }

      // Chuỗi gốc từ LMS có 2 dạng:
      //   "i-Build(Book 1 > Looking for Fun)"                          -> hoạt động đơn giản
      //   "i-Create(Dialogue Speaking)(Book 1 > Looking for Fun)"      -> i-Create có phân loại phụ
      // NHƯNG không phải dòng nào cũng có đủ cả 2 cặp ngoặc — có lúc chỉ có
      // "i-Create(Dialogue Speaking)" một mình, không kèm tên bài học phía sau.
      // Vì vậy KHÔNG dựa vào số lượng cặp ngoặc để đoán, mà dựa vào đặc điểm:
      // tên bài học luôn chứa dấu ">" (VD "Book 1 > Looking for Fun"), còn
      // phân loại phụ của i-Create thì không bao giờ có dấu ">".
      const parseExamName = raw => {
        const s = String(raw ?? "").trim();
        const groups = [...s.matchAll(/\(([^()]*)\)/g)].map(m => m[1].trim());
        const prefix = s.split("(")[0].trim();
        const lower = prefix.toLowerCase();
        const baseActivity = activityOrder.find(a => lower.startsWith(a.toLowerCase())) || prefix || "Unknown";

        const lessonGroup = groups.find(g => g.includes(">"));
        const nonLessonGroups = groups.filter(g => g !== lessonGroup);

        if (baseActivity.toLowerCase() === "i-create" && nonLessonGroups.length > 0) {
          return { activity: `i-Create (${nonLessonGroups[0]})`, lesson: lessonGroup || "" };
        }
        return { activity: baseActivity, lesson: lessonGroup || "" };
      };
      const rawScore = v => (v === null || v === undefined || v === "" ? "" : v);

      const students = new Map();
      const classCalendars = new Map(); // classCode -> { lectureNo: "YYYY-MM-DD" }
      const errors = [];
      let done = 0;

      async function fetchClassCalendar(item) {
        try {
          const journalRows = await post("CounClassInfoJournalList", { counn: { coun_cls_id: String(item.cls_id) } });
          const calendar = {};
          journalRows.forEach(r => {
            const m = String(r.Lecture ?? "").match(/\d+/);
            if (!m) return;
            const lecNo = Number(m[0]);
            const date = r.cjrn_classdate;
            if (date && (!calendar[lecNo] || date < calendar[lecNo])) calendar[lecNo] = date;
          });
          if (Object.keys(calendar).length) {
            classCalendars.set(`${item.Branch}||${item.Class}`, calendar);
          }
        } catch (err) {
          // Không lấy được lịch học cũng không sao — build.py sẽ tự fallback nếu thiếu
        }
      }

      async function processClass(item) {
        try {
          await fetchClassCalendar(item);
          const lectureRows = await post("CounRptLectureList", { counn: { cls_id: item.cls_id } });
          const lectures = lectureRows
            .map(x => ({
              id: Number(x.ssect_id),
              order: Number(x.ssect_order) || Number(String(x.ssect_name ?? "").match(/\d+/)?.[0]) || 0
            }))
            .filter(x => x.id && x.order >= LECTURE_FROM && x.order <= LECTURE_TO)
            .sort((a, b) => a.order - b.order);

          for (const lecture of lectures) {
            const rows = await post("ReportGrdWeekliGradeList", {
              ret: {
                rt_brch_id: item.brch_id,
                rt_bsem_id: item.bsem_id,
                rt_cors_id: item.cors_id,
                rt_syl_id: item.syl_id,
                rt_cls_id: item.cls_id,
                rt_ssect_id: lecture.id,
                rt_learn_type: "i-Learning",
                rt_preview: 0,
                rt_review: 0,
                rt_skill: 0,
                rt_notgrade: 0
              }
            });

            for (const r of rows) {
              const lectureNo = Number(r.ssect_order) || lecture.order;
              // esdtl_type mới là field có ĐẦY ĐỦ cả phân loại lẫn tên bài học
              // (VD "i-Create(Dialogue Speaking)(Book 1 > Ant and Cat Box)").
              // ssexam_name chỉ có phần phân loại, KHÔNG có tên bài học -> đây là
              // lý do tên bài học bị thiếu ở bản trước, giữ ssexam_name làm fallback
              // phòng trường hợp esdtl_type thiếu.
              const { activity, lesson } = parseExamName(r.esdtl_type || r.ssexam_name);
              const studentId = r.cstd_id ?? r.cstd_id1 ?? r.std_id ?? "";
              const studentName = r.std_name ?? "";
              const className = r.cls_name || item.Class;
              const key = [item.Branch, className, studentId, studentName].join("||");
              if (!students.has(key)) {
                students.set(key, {
                  Branch: item.Branch,
                  Program: r.top_cors_name || item.Program_From_Plan || item.Program_LMS,
                  Syllabus: item.Syllabus_From_Plan || item.Syllabus_LMS,
                  Class: className,
                  ID: studentId,
                  Name: studentName,
                  lectures: {}
                });
              }
              const student = students.get(key);
              if (!student.lectures[lectureNo]) student.lectures[lectureNo] = {};
              // Nếu 1 lecture có nhiều dòng cùng activity (hiếm, trùng lặp dữ liệu),
              // giữ dòng đầu tiên vào đúng tên, dòng sau đánh số thêm.
              let actKey = activity;
              let suffix = 2;
              while (Object.prototype.hasOwnProperty.call(student.lectures[lectureNo], actKey)) {
                actKey = `${activity} (${suffix++})`;
              }
              student.lectures[lectureNo][actKey] = rawScore(r.score);
              // Tên bài học giống nhau cho mọi hoạt động trong cùng 1 lecture -> lưu 1 lần
              if (lesson && !student.lectures[lectureNo]._lessonName) {
                student.lectures[lectureNo]._lessonName = lesson;
              }
            }

            await sleep(REQUEST_DELAY_MS);
          }
        } catch (err) {
          errors.push({ Branch: item.Branch, Class: item.Class, Error: String(err?.message ?? err) });
        } finally {
          done++;
          if (done % 10 === 0 || done === classes.length) {
            console.log(`Đã xử lý ${done}/${classes.length} lớp | Lỗi: ${errors.length}`);
          }
          if (done % CHECKPOINT_EVERY === 0 || done === classes.length) {
            // Chụp nhanh + xóa NGAY (đồng bộ, chưa await) để các lớp đang xử lý
            // song song khác không bị mất dữ liệu nếu chúng ghi vào đúng lúc này.
            const batch = [...students.values()];
            const errBatch = [...errors];
            const calBatch = Object.fromEntries(classCalendars);
            students.clear();
            errors.length = 0;
            classCalendars.clear();
            await window.__saveCheckpoint(batch, errBatch, calBatch, done, classes.length);
          }
          await sleep(REQUEST_DELAY_MS);
        }
      }

      let index = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (index < classes.length && Date.now() < deadline) await processClass(classes[index++]);
        })
      );

      // Xả nốt phần chưa kịp checkpoint (nếu dừng không đúng mốc CHECKPOINT_EVERY)
      if (students.size > 0 || errors.length > 0 || classCalendars.size > 0) {
        await window.__saveCheckpoint([...students.values()], errors, Object.fromEntries(classCalendars), done, classes.length);
      }

      return { totalErrors: errors.length, stoppedEarly: index < classes.length, processedIndex: index };
      },
      { BASE, classes: classesForCycle, LECTURE_FROM, LECTURE_TO, deadline }
    );
  } catch (err) {
    console.log("== Bước export bị gián đoạn giữa chừng ==");
    console.log("Lý do:", String(err?.message ?? err));
    if (allStudents.length > 0) {
      console.log(`Vẫn còn checkpoint gần nhất với ${allStudents.length} dòng học viên đã lưu ở data/raw_scores.json — build.py sẽ dùng tạm dữ liệu này.`);
    } else {
      console.log("Chưa có checkpoint nào được lưu (bị cắt ngang quá sớm) — data/raw_scores.json giữ nguyên bản cũ (nếu có).");
    }
    await browser.close();
    // Không throw tiếp nữa: để job không bị đánh dấu "failed" cứng, cho phép
    // các bước build + commit phía sau vẫn chạy với dữ liệu checkpoint đã có.
    process.exit(0);
  }

  console.log(`Điểm raw (cộng dồn cả vòng tới nay): ${allStudents.length} dòng học viên. Lỗi: ${allErrors.length}`);

  if (step2.stoppedEarly) {
    console.log(`== Hết thời gian nội bộ (${TIME_BUDGET_MS / 60000} phút) trước khi xong hết vòng ==`);
    console.log(`Đã xử lý ${step2.processedIndex}/${classesForCycle.length} lớp trong lần chạy này. Còn lại ${classesForCycle.length - step2.processedIndex} lớp sẽ được lần chạy kế tiếp (theo lịch 6h/12h/18h) tiếp tục.`);
    // state file đã được checkpoint cập nhật remainingClasses đúng rồi, không cần ghi lại.
  } else {
    console.log("== Đã quét xong toàn bộ lớp trong vòng này ==");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ status: "done", cycleFinishedAt: new Date().toISOString(), totalClassesInCycle }, null, 2)
    );
  }

  // ================= Ghi file output cuối cùng (đầy đủ, không phải checkpoint) =================
  saveOutputs(allStudents, allErrors, allCalendars, { checkpoint: !step2.stoppedEarly ? false : true });

  await browser.close();
  console.log("== Hoàn tất ==");
}

main().catch(err => {
  console.error("Scrape thất bại:", err);
  process.exit(1);
});
