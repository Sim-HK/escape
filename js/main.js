import { GestureTracker, startCamera, createLandmarker, runLoop, drawHand } from "./hands.js";

const $ = (s) => document.querySelector(s);
const svg = $("#scene");
const cursorEl = $("#cursor");
const heldEl = $("#held");
const tipEl = $("#tip");
const toastEl = $("#toast");

const ITEM_NAMES = { screwdriver: "드라이버", fuse: "퓨즈", wrench: "렌치" };
const PUZZLES = 5;

// ---------------- 게임 상태 ----------------
let S;
function resetState() {
  let code;
  do code = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10));
  while (new Set(code).size < 3);
  S = {
    code,
    solved: new Set(),
    inv: [],
    held: null,
    heldFrom: null,
    f: {},
    drag: null,
    modal: null,
    entry: "",
    start: performance.now(),
    running: false,
    won: false,
  };
}

// ---------------- 입력 좌표 ----------------
const pointer = { x: innerWidth / 2, y: innerHeight / 2, handActive: false, lastHand: 0 };

function toScene(x, y) {
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
function fromScene(x, y) {
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  return pt.matrixTransform(svg.getScreenCTM());
}
const inRect = (p, [x, y, w, h]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;

// ---------------- 장면 헬퍼 ----------------
const el = (id) => document.getElementById(id);
const show = (id) => { el(id).style.display = ""; };
const hide = (id) => { el(id).style.display = "none"; };
function replay(node, cls) {
  node.classList.remove(cls);
  void node.getBoundingClientRect();
  node.classList.add(cls);
}

let toastTimer;
function say(msg, good = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("good", good);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), good ? 4200 : 3200);
}

function clueText(n) {
  return `${"①②③④"[n]} ${S.code[n]}`;
}

function addMemo(n) {
  const li = document.createElement("li");
  li.textContent = clueText(n);
  li.dataset.n = n;
  const list = $("#memoList");
  list.appendChild(li);
  [...list.children].sort((a, b) => a.dataset.n - b.dataset.n).forEach((c) => list.appendChild(c));
}

function solve(n, clue) {
  if (S.solved.has(n)) return;
  S.solved.add(n);
  if (clue !== undefined) addMemo(clue);
  renderDots();
}

function renderDots() {
  $("#dots").innerHTML = Array.from({ length: PUZZLES }, (_, i) => `<i class="${i < S.solved.size ? "on" : ""}"></i>`).join("");
}

function itemSvg(id) {
  return `<svg viewBox="0 0 100 100"><use href="#sym-${id}"/></svg>`;
}

function renderInv() {
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const it = S.inv[i];
    slots.push(
      it
        ? `<div class="slot filled" data-action="inv" data-index="${i}" title="${ITEM_NAMES[it]}">${itemSvg(it)}</div>`
        : `<div class="slot"></div>`
    );
  }
  $("#inv").innerHTML = slots.join("");
}

// ---------------- 퍼즐 동작 ----------------
function openVent() {
  S.f.ventOpen = true;
  el("ventCover").classList.add("fall");
  setTimeout(() => {
    el("ventInside").style.opacity = 1;
    hide("ventCover");
  }, 500);
  solve(1, 0);
  say("나사를 풀자 환풍구 덮개가 떨어졌다! 안쪽 벽에 분필 글씨… 그리고 퓨즈가 보인다.", true);
}

function insertFuse() {
  S.f.fuseIn = true;
  show("fuseInBox");
  el("jboxLed").setAttribute("fill", "#5cff8a");
  el("bulb").classList.add("sway");
  setTimeout(() => {
    document.body.classList.add("uv");
    solve(2, 1);
    say("딸깍. 전구가 보랏빛 자외선으로 바뀌었다! 파란 종이에 무언가 떠오른다.", true);
  }, 500);
}

function breakBox() {
  S.f.boxBroken = true;
  hide("box");
  show("boxBroken");
  replay(el("boxBroken"), "pop");
  say("콰직! 상자를 해체했다. 안에서 렌치가 굴러 나왔다.", true);
}

function turnValve() {
  S.f.valve = true;
  el("valve").classList.add("turn");
  el("leak").classList.add("stop");
  setTimeout(() => el("puddle").classList.add("drain"), 900);
  el("drain").classList.add("drained");
  solve(3, 2);
  say("렌치로 밸브를 끝까지 잠갔다. 물이 빠지면서 배수구 뚜껑이 드러난다…", true);
}

function openDrawer() {
  S.f.drawerOpen = true;
  hide("drawerClosed");
  show("drawerOpen");
  say("드르륵— 서랍이 열렸다. 플라스틱 캡슐이 들어 있다. 단단히 잠겨 있다.");
}

function breakCapsule() {
  S.f.capsuleBroken = true;
  el("capTop").classList.add("open");
  el("capBot").classList.add("open");
  setTimeout(() => {
    show("note");
    replay(el("note"), "pop");
  }, 350);
  solve(4, 3);
  say("팡! 캡슐이 갈라지며 쪽지가 튀어나왔다.", true);
}

function openDoor() {
  S.f.doorOpen = true;
  el("keypadLed").setAttribute("fill", "#5cff8a");
  hide("doorClosed");
  show("doorOpen");
  replay(el("doorOpen"), "pop");
  solve(5);
  S.won = true;
  setTimeout(() => {
    $("#winTime").textContent = fmtTime(performance.now() - S.start);
    $("#win").classList.remove("hidden");
    document.body.classList.remove("playing");
    document.body.classList.add("playing-win");
  }, 1800);
}

// ---------------- 상호작용 지점 ----------------
// rect: 장면 좌표 [x, y, w, h]. 위에 있는 항목이 우선.
const HOTSPOTS = [
  {
    label: "퓨즈", rect: [555, 128, 120, 100],
    when: () => S.f.ventOpen && !S.f.fuseTaken,
    pick: () => { S.f.fuseTaken = true; hide("fuseInVent"); return "fuse"; },
  },
  {
    label: "환풍구", rect: [515, 100, 220, 175],
    pinch: () => say(S.f.ventOpen ? `덕트 안쪽 벽에 분필로 "${clueText(0)}" 이라고 적혀 있다.` : "나사 네 개로 꽉 조여 있다. 손으로는 안 열린다."),
    drop: (it) => it === "screwdriver" && !S.f.ventOpen && (openVent(), true),
    burst: () => say("주먹으로 부수기엔 너무 단단한 철판이다."),
  },
  {
    label: "드라이버", rect: [70, 412, 140, 56],
    when: () => !S.f.sdTaken,
    pick: () => { S.f.sdTaken = true; hide("sdOnBoard"); return "screwdriver"; },
  },
  {
    label: "공구판", rect: [58, 312, 165, 252],
    pinch: () => say("나머지 공구는 녹이 슬어 판에 들러붙었다."),
  },
  {
    label: "전기함", rect: [1160, 326, 96, 100],
    pinch: () => say(S.f.fuseIn ? "전기가 들어오고 있다." : "퓨즈 꽂는 자리가 비어 있다. 전기가 안 들어온다."),
    drop: (it) => it === "fuse" && !S.f.fuseIn && (insertFuse(), true),
  },
  {
    label: "파란 종이", rect: [1292, 232, 142, 186],
    pinch: () => say(S.f.fuseIn ? `자외선에 비친 글씨: "${clueText(1)}"` : "그냥 파란 종이다. 특별한 빛을 비추면 보일지도…?"),
  },
  {
    label: "렌치", rect: [100, 905, 120, 100],
    when: () => S.f.boxBroken && !S.f.wrenchTaken,
    pick: () => { S.f.wrenchTaken = true; hide("wrenchOnFloor"); return "wrench"; },
  },
  {
    label: "FRAGILE 상자", rect: [35, 855, 250, 158],
    when: () => !S.f.boxBroken,
    pinch: () => { replay(el("box"), "shake"); say("테이프로 칭칭 감겨 있다. 주먹을 꽉 쥐었다가 확 펴서 해체해볼까?"); },
    burst: breakBox,
  },
  {
    label: "빨간 밸브", rect: [1474, 398, 84, 86],
    pinch: () => say(S.f.valve ? "완전히 잠겨 있다." : "손으로는 꿈쩍도 안 한다. 공구가 필요하다."),
    drop: (it) => it === "wrench" && !S.f.valve && (turnValve(), true),
  },
  {
    label: "물웅덩이", rect: [1290, 840, 400, 90],
    pinch: () => say(S.f.valve ? `배수구 옆 바닥에 "${clueText(2)}" 이 새겨져 있다.` : "물이 계속 새어 나와 바닥이 안 보인다. 어디서 새는 걸까?"),
  },
  {
    label: "서랍", rect: [305, 630, 175, 125],
    when: () => S.f.drawerOpen,
    pinch: () => say(S.f.capsuleBroken ? "빈 캡슐 조각만 남았다." : "캡슐은 손으로 안 열린다. 주먹을 쥐었다 펴서 깨볼까?"),
    burst: () => (S.f.capsuleBroken ? say("이미 깨졌다.") : breakCapsule()),
  },
  {
    label: "서랍", rect: [335, 632, 112, 64],
    when: () => !S.f.drawerOpen,
    pinch: (p) => { S.drag = { type: "drawer", from: p }; say("손가락을 모은 채로 당겨보자!"); },
    burst: () => say("서랍은 부수지 말고 당겨서 열자."),
  },
  {
    label: "쪽지", rect: [125, 540, 150, 72],
    when: () => S.f.capsuleBroken,
    pinch: () => say(`쪽지에 "${clueText(3)}" 라고 적혀 있다. 원 숫자는… 순서?`),
  },
  {
    label: "도어 키패드", rect: [712, 462, 76, 108],
    pinch: () => openKeypad(),
  },
  {
    label: "문", rect: [812, 138, 296, 712],
    pinch: () => say("굳게 잠겨 있다. 왼쪽에 4자리 키패드가 보인다."),
    burst: () => say("문은 꿈쩍도 하지 않는다. 손만 아프다."),
  },
  // ---- 분위기용 트릭들 ----
  { label: "세제 통", rect: [460, 205, 70, 118], pinch: () => say("세제 통이다. 텅 비어 있다.") },
  {
    label: "탄산음료", rect: [495, 340, 52, 132],
    pinch: () => say("흔들어진 탄산음료다. 터뜨리면 난리 나겠는데…"),
    burst: () => { replay(el("soda"), "shake"); say("치이익— 뚜껑이 날아갔다! 하지만 안에는 아무것도 없다."); },
  },
  { label: "전동 드릴", rect: [312, 500, 110, 100], pinch: () => say("배터리가 없다. 쓸 수 없다.") },
  { label: "의자", rect: [418, 575, 225, 375], pinch: () => say("삐걱거리는 나무 의자다.") },
  {
    label: "전구", rect: [1636, 130, 74, 112],
    pinch: () => { replay(el("bulb"), "sway"); say(S.f.fuseIn ? "보랏빛 자외선 전구다." : "전구가 흔들린다. 배선이 끊긴 것 같다… 전기함을 살펴보자."); },
  },
  { label: "세면대", rect: [1270, 428, 216, 190], pinch: () => say("수도꼭지가 녹슬어 돌아가지 않는다.") },
  { label: "호스", rect: [1610, 262, 124, 196], pinch: () => say("낡은 고무 호스다. 구멍이 숭숭 뚫려 있다.") },
  {
    label: "삽과 쇠스랑", rect: [1790, 370, 130, 540],
    pinch: () => { replay(el("tools"), "shake"); say("녹슨 농기구다. 이걸로 문을 부수긴 무리다."); },
  },
  { label: "창문", rect: [0, 8, 205, 194], pinch: () => say("철창이 박힌 작은 창이다. 바깥 햇빛만 들어온다.") },
  { label: "배관", rect: [1512, 0, 72, 640], pinch: () => say("차가운 배관이다. 안에서 물 흐르는 소리가 난다.") },
];

function hotspotAt(p) {
  return HOTSPOTS.find((h) => (!h.when || h.when()) && inRect(p, h.rect));
}

// ---------------- 키패드 ----------------
function openKeypad() {
  S.modal = "keypad";
  S.entry = "";
  renderKp();
  $("#keypadModal").classList.remove("hidden");
}
function closeKeypad() {
  S.modal = null;
  $("#keypadModal").classList.add("hidden");
}
function renderKp(err = false) {
  const d = $("#kpDisplay");
  d.textContent = (S.entry + "____").slice(0, 4);
  d.classList.toggle("err", err);
}
function pressKey(k, btn) {
  replay(btn, "press");
  if (k === "C") S.entry = "";
  else if (k === "OK") {
    if (S.entry === S.code.join("")) {
      renderKp();
      say("삐빅! 잠금이 풀렸다!", true);
      setTimeout(() => { closeKeypad(); openDoor(); }, 500);
      return;
    }
    renderKp(true);
    replay($(".kp-panel"), "shake");
    say(S.solved.size < 4 ? "틀렸다. 아직 찾지 못한 숫자가 있는 것 같다." : "틀렸다. 메모의 원 숫자 순서대로 입력해보자.");
    S.entry = "";
    setTimeout(() => renderKp(), 700);
    return;
  } else if (S.entry.length < 4) S.entry += k;
  renderKp();
}

// ---------------- 공통 입력 처리 ----------------
function actionElAt(x, y) {
  const node = document.elementFromPoint(x, y);
  return node?.closest("[data-action]") ?? null;
}

function onMove(x, y) {
  pointer.x = x;
  pointer.y = y;
  cursorEl.style.transform = `translate(${x}px, ${y}px)`;
  heldEl.style.transform = `translate(${x}px, ${y}px)`;
  tipEl.style.left = x + "px";
  tipEl.style.top = y + "px";
  if (!S?.running) return;

  if (S.drag?.type === "drawer") {
    const p = toScene(x, y);
    if (Math.hypot(p.x - S.drag.from.x, p.y - S.drag.from.y) > 60) {
      S.drag = null;
      openDrawer();
    }
  }
  updateHover();
}

let hotBtn = null;
function updateHover() {
  const { x, y } = pointer;
  const act = actionElAt(x, y);
  if (hotBtn !== act) {
    hotBtn?.classList.remove("hot");
    hotBtn = act && act.tagName === "BUTTON" ? act : null;
    hotBtn?.classList.add("hot");
  }
  let label = "";
  if (!S.modal && !S.won) {
    if (act?.dataset.action === "inv") label = ITEM_NAMES[S.inv[act.dataset.index]];
    else {
      const h = hotspotAt(toScene(x, y));
      if (h) label = S.held ? `${ITEM_NAMES[S.held]} → ${h.label}` : h.label;
    }
  }
  tipEl.textContent = label;
  tipEl.classList.toggle("show", !!label);
  cursorEl.classList.toggle("hover", !!label || !!hotBtn);
}

function onPinchStart() {
  cursorEl.classList.add("pinch");
  const { x, y } = pointer;
  const act = actionElAt(x, y);

  if (S.won) {
    if (act?.dataset.action === "restart") restart();
    return;
  }
  if (!S.running) return;

  if (S.modal === "keypad") {
    if (act?.dataset.action === "kp") pressKey(act.dataset.key, act);
    else if (act?.dataset.action === "kp-close" || !document.elementFromPoint(x, y)?.closest(".kp-panel")) closeKeypad();
    return;
  }

  if (act?.dataset.action === "inv") {
    const i = +act.dataset.index;
    S.held = S.inv[i];
    S.inv.splice(i, 1);
    renderInv();
    renderHeld();
    return;
  }

  const p = toScene(x, y);
  const h = hotspotAt(p);
  if (!h) return;
  if (h.pick) {
    S.held = h.pick();
    renderHeld();
    say(`${ITEM_NAMES[S.held]}를 집었다.`);
  } else h.pinch?.(p);
  updateHover();
}

function onPinchEnd() {
  cursorEl.classList.remove("pinch");
  if (!S?.running) return;
  if (S.drag) {
    S.drag = null;
  }
  if (!S.held) return;
  const item = S.held;
  S.held = null;
  renderHeld();
  const h = hotspotAt(toScene(pointer.x, pointer.y));
  if (h?.drop && h.drop(item)) {
    updateHover();
    return;
  }
  S.inv.push(item);
  renderInv();
  if (h) say(`${ITEM_NAMES[item]}는 여기에 쓸 수 없다.`);
  updateHover();
}

function onBurst(x, y) {
  burstFx(x, y);
  if (!S?.running || S.modal) return;
  const h = hotspotAt(toScene(x, y));
  if (h?.burst) h.burst();
  else if (h) say(`${h.label}… 부술 만한 물건은 아니다.`);
  else say("허공을 향해 손을 펼쳤다. 아무 일도 없다.");
  updateHover();
}

function renderHeld() {
  heldEl.innerHTML = S.held ? itemSvg(S.held) : "";
}

function burstFx(x, y) {
  const colors = ["#ffd36b", "#ff8a5a", "#fff", "#c9a46d"];
  const ring = document.createElement("div");
  ring.className = "shock";
  ring.style.left = x + "px";
  ring.style.top = y + "px";
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 600);
  for (let i = 0; i < 16; i++) {
    const d = document.createElement("div");
    const ang = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
    const r = 70 + Math.random() * 90;
    d.className = "burst";
    d.style.left = x + "px";
    d.style.top = y + "px";
    d.style.background = colors[i % colors.length];
    d.style.setProperty("--dx", Math.cos(ang) * r + "px");
    d.style.setProperty("--dy", Math.sin(ang) * r + "px");
    d.style.setProperty("--r", Math.random() * 360 + "deg");
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 750);
  }
}

// ---------------- 제스처 표시 ----------------
const GESTURE_UI = {
  none: ["🙈", "손이 보이지 않아요"],
  hand: ["✋", "손 인식됨"],
  open: ["🖐", "손 인식됨"],
  pinch: ["🤏", "집는 중"],
  fist: ["✊", "주먹! 펴면 해체"],
  mouse: ["🖱", "마우스 모드"],
};
function setGestureUI(name) {
  const [icon, text] = GESTURE_UI[name];
  $("#gIcon").textContent = icon;
  $("#gText").textContent = text;
  cursorEl.classList.toggle("armed", name === "fist");
  cursorEl.classList.toggle("nohand", name === "none");
}

// ---------------- 카메라 / 마우스 연결 ----------------
const tracker = new GestureTracker({
  move: (nx, ny) => onMove(nx * innerWidth, ny * innerHeight),
  pinchStart: onPinchStart,
  pinchEnd: onPinchEnd,
  burst: (nx, ny) => onBurst(nx * innerWidth, ny * innerHeight),
  state: (name) => setGestureUI(name),
});

async function startWithCamera() {
  const status = $("#startStatus");
  const btns = document.querySelectorAll("#start button");
  btns.forEach((b) => (b.disabled = true));
  try {
    status.textContent = "카메라 권한을 요청하는 중…";
    const video = $("#video");
    await startCamera(video);
    status.textContent = "손 인식 모델을 불러오는 중… (처음엔 몇 초 걸려요)";
    const landmarker = await createLandmarker();
    const ctx = $("#overlay").getContext("2d");
    $("#camBox").classList.remove("hidden");
    runLoop(video, landmarker, (lm) => {
      const now = performance.now();
      if (lm) { pointer.handActive = true; pointer.lastHand = now; }
      tracker.update(lm, now);
      drawHand(ctx, lm, tracker.stateName);
    });
    setGestureUI("none");
    begin();
    say("손을 카메라에 보여주세요. 엄지와 검지를 모으면 물건을 집어요.");
  } catch (err) {
    console.error(err);
    status.textContent = "카메라를 쓸 수 없어요: " + (err.message || err) + " — 마우스로 시작해보세요.";
    btns.forEach((b) => (b.disabled = false));
  }
}

function startWithMouse() {
  setGestureUI("mouse");
  begin();
  say("클릭&드래그로 집고, 우클릭(또는 F키)으로 주먹→펴기를 할 수 있어요.");
}

const handRecent = () => pointer.handActive && performance.now() - pointer.lastHand < 600;
addEventListener("mousemove", (e) => { if (!handRecent()) onMove(e.clientX, e.clientY); });
addEventListener("mousedown", (e) => {
  if (e.button !== 0 || handRecent() || !document.body.classList.contains("playing") && !S?.won) return;
  onMove(e.clientX, e.clientY);
  onPinchStart();
});
addEventListener("mouseup", (e) => { if (e.button === 0 && !handRecent()) onPinchEnd(); });
addEventListener("contextmenu", (e) => {
  if (!S?.running) return;
  e.preventDefault();
  onBurst(e.clientX, e.clientY);
});
addEventListener("keydown", (e) => {
  if (!S?.running) return;
  if (e.key === "f" || e.key === "F") onBurst(pointer.x, pointer.y);
  if (e.key === "Escape" && S.modal) closeKeypad();
});

// ---------------- 진행 ----------------
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
setInterval(() => {
  if (S?.running && !S.won) $("#timer").textContent = fmtTime(performance.now() - S.start);
}, 250);

function fillClues() {
  el("clue1").textContent = clueText(0);
  el("clue2").textContent = clueText(1);
  el("clue3").textContent = clueText(2);
  el("clue4").textContent = clueText(3);
}

function begin() {
  $("#start").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  document.body.classList.add("playing");
  S.running = true;
  S.start = performance.now();
}

function restart() {
  // 장면을 처음 상태로 되돌리기 위해 가장 확실한 방법: 새로 고침 없이 DOM 상태 초기화
  document.body.classList.remove("uv", "playing-win");
  el("ventCover").classList.remove("fall"); show("ventCover"); el("ventInside").style.opacity = 0; show("fuseInVent");
  show("sdOnBoard");
  hide("fuseInBox"); el("jboxLed").setAttribute("fill", "#5a2a2a");
  show("box"); hide("boxBroken"); show("wrenchOnFloor");
  el("valve").classList.remove("turn"); el("puddle").classList.remove("drain"); el("leak").classList.remove("stop"); el("drain").classList.remove("drained");
  show("drawerClosed"); hide("drawerOpen"); hide("note"); el("capTop").classList.remove("open"); el("capBot").classList.remove("open");
  show("doorClosed"); hide("doorOpen"); el("keypadLed").setAttribute("fill", "#ff4a3a");
  $("#memoList").innerHTML = "";
  $("#win").classList.add("hidden");
  resetState();
  fillClues();
  renderDots();
  renderInv();
  renderHeld();
  begin();
}

$("#btnCam").addEventListener("click", startWithCamera);
$("#btnMouse").addEventListener("click", startWithMouse);

resetState();
fillClues();
renderDots();
renderInv();

// 디버그/테스트용
window.__game = { get state() { return S; } };
