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

  // ================= BƯỚC 1: Class Plan + Class ID Cache =================
  console.log("== Đang build Class Plan + Class ID Cache ==");
  const step1 = await page.evaluate(
    async ({ BASE, STAFF_ID, BRANCHES }) => {
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

      for (const branch of BRANCHES) {
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

      return { cacheRows, errorRows };
    },
    { BASE, STAFF_ID, BRANCHES }
  );

  console.log(`Class ID Cache: ${step1.cacheRows.length} lớp. Lỗi: ${step1.errorRows.length}`);

  // ================= Chuẩn bị ghi checkpoint + output =================
  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });

  function saveOutputs(students, errors, meta) {
    fs.writeFileSync(path.join(outDir, "raw_scores.json"), JSON.stringify(students));
    fs.writeFileSync(
      path.join(outDir, "run_log.json"),
      JSON.stringify(
        {
          run_at: new Date().toISOString(),
          classes_total: step1.cacheRows.length,
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
  // ghi checkpoint xuống đĩa ngay lập tức -> nếu job bị cắt ngang giữa chừng
  // (VD sự cố hạ tầng của Actions) thì vẫn còn dữ liệu đã cào được tới lúc đó,
  // không phải làm lại từ đầu.
  let lastCheckpointCount = 0;
  await context.exposeFunction("__saveCheckpoint", (studentsSnapshot, errorsSnapshot, done, total) => {
    lastCheckpointCount = studentsSnapshot.length;
    saveOutputs(studentsSnapshot, errorsSnapshot, {
      checkpoint: true,
      progress: `${done}/${total}`
    });
    console.log(`[Checkpoint] Đã lưu tạm ${studentsSnapshot.length} dòng học viên (${done}/${total} lớp).`);
  });

  // ================= BƯỚC 2: Export điểm raw theo lecture =================
  console.log("== Đang export điểm raw i-Learning ==");
  let step2;
  try {
    step2 = await page.evaluate(
      async ({ BASE, classes, LECTURE_FROM, LECTURE_TO }) => {
        const CONCURRENCY = 3;
        const REQUEST_DELAY_MS = 150;
        const CHECKPOINT_EVERY = 100;
        const activityOrder = ["i-Build", "i-Read", "i-Listen", "i-Imagine", "i-Create"];
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

      const getActivity = raw => {
        const s = String(raw ?? "").trim();
        const lower = s.toLowerCase();
        if (lower.startsWith("i-create")) return "i-Create";
        return activityOrder.find(a => lower.startsWith(a.toLowerCase())) || s.split("(")[0] || "Unknown";
      };
      const rawScore = v => (v === null || v === undefined || v === "" ? "" : v);

      const students = new Map();
      const errors = [];
      let done = 0;

      async function processClass(item) {
        try {
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
              const activity = getActivity(r.ssexam_name);
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
              // Nếu 1 lecture có nhiều dòng cùng activity (VD i-Create + i-Create (2)),
              // giữ dòng đầu tiên vào đúng tên, dòng sau đánh số thêm.
              let actKey = activity;
              let suffix = 2;
              while (Object.prototype.hasOwnProperty.call(student.lectures[lectureNo], actKey)) {
                actKey = `${activity} (${suffix++})`;
              }
              student.lectures[lectureNo][actKey] = rawScore(r.score);
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
            await window.__saveCheckpoint([...students.values()], errors, done, classes.length);
          }
          await sleep(REQUEST_DELAY_MS);
        }
      }

      let index = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (index < classes.length) await processClass(classes[index++]);
        })
      );

      return { students: [...students.values()], errors };
      },
      { BASE, classes: step1.cacheRows, LECTURE_FROM, LECTURE_TO }
    );
  } catch (err) {
    console.log("== Bước export bị gián đoạn giữa chừng ==");
    console.log("Lý do:", String(err?.message ?? err));
    if (lastCheckpointCount > 0) {
      console.log(`Vẫn còn checkpoint gần nhất với ${lastCheckpointCount} dòng học viên đã lưu ở data/raw_scores.json — build.py sẽ dùng tạm dữ liệu này.`);
    } else {
      console.log("Chưa có checkpoint nào được lưu (bị cắt ngang quá sớm) — data/raw_scores.json giữ nguyên bản cũ (nếu có).");
    }
    await browser.close();
    // Không throw tiếp nữa: để job không bị đánh dấu "failed" cứng, cho phép
    // các bước build + commit phía sau vẫn chạy với dữ liệu checkpoint đã có.
    process.exit(0);
  }

  console.log(`Điểm raw: ${step2.students.length} dòng học viên. Lỗi: ${step2.errors.length}`);

  // ================= Ghi file output cuối cùng (đầy đủ, không phải checkpoint) =================
  saveOutputs(step2.students, step2.errors, { checkpoint: false });

  await browser.close();
  console.log("== Hoàn tất ==");
}

main().catch(err => {
  console.error("Scrape thất bại:", err);
  process.exit(1);
});
