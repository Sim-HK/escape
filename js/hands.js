// 노트북 카메라 + MediaPipe Hand Landmarker 로 손 제스처를 인식한다.
// 제스처: 손 이동(커서), 손가락 모으기(집기), 주먹 쥐었다 펴기(해체)

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [끝마디, 가운데마디]

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

export async function createLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch {
    return await HandLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

export function runLoop(video, landmarker, onResult) {
  let lastTime = -1;
  const tick = () => {
    if (video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      const res = landmarker.detectForVideo(video, performance.now());
      onResult(res.landmarks?.[0] ?? null);
    }
    requestAnimationFrame(tick);
  };
  tick();
}

export function classify(lm) {
  const wrist = lm[0];
  const palm = dist(lm[0], lm[9]) || 1e-6;
  const curled = FINGERS.map(([t, p]) => dist(lm[t], wrist) < dist(lm[p], wrist) * 1.02);
  const extended = FINGERS.map(([t, p]) => dist(lm[t], wrist) > dist(lm[p], wrist) * 1.2);
  return {
    pinchRatio: dist(lm[4], lm[8]) / palm,
    curledCount: curled.filter(Boolean).length,
    extendedCount: extended.filter(Boolean).length,
    indexCurled: curled[0],
  };
}

/**
 * 랜드마크 → 게임 이벤트 변환기.
 * handlers: move(nx, ny), pinchStart(), pinchEnd(), burst(nx, ny), state(name, armed)
 * nx, ny 는 화면 기준 0~1 좌표 (좌우 반전 적용됨)
 */
export class GestureTracker {
  constructor(handlers) {
    this.h = handlers;
    this.x = 0.5;
    this.y = 0.5;
    this.pinching = false;
    this.fistSince = 0;
    this.armed = false;
    this.armedAt = 0;
    this.armedPos = null;
    this.lastSeen = 0;
    this.stateName = "none";
  }

  setState(name) {
    if (name !== this.stateName) {
      this.stateName = name;
      this.h.state?.(name, this.armed);
    }
  }

  update(lm, now = performance.now()) {
    if (!lm) {
      if (this.stateName !== "none" && now - this.lastSeen > 350) {
        if (this.pinching) { this.pinching = false; this.h.pinchEnd?.(); }
        this.armed = false;
        this.fistSince = 0;
        this.setState("none");
      }
      return;
    }
    this.lastSeen = now;
    const c = classify(lm);

    // 커서: 엄지·검지 끝의 중간점. 카메라 가장자리까지 손을 뻗지 않아도 되도록 중앙 영역을 확대.
    const px = 1 - (lm[4].x + lm[8].x) / 2;
    const py = (lm[4].y + lm[8].y) / 2;
    const tx = clamp((px - 0.15) / 0.7, 0, 1);
    const ty = clamp((py - 0.12) / 0.66, 0, 1);
    const speed = Math.hypot(tx - this.x, ty - this.y);
    const a = clamp(0.22 + speed * 6, 0.22, 0.85); // 빠를 때는 즉각, 느릴 때는 부드럽게
    this.x += (tx - this.x) * a;
    this.y += (ty - this.y) * a;
    this.h.move?.(this.x, this.y);

    const isFist = c.curledCount >= 4;
    const isOpen = c.extendedCount >= 3;

    // 집기 (히스테리시스로 떨림 방지)
    if (!this.pinching && !isFist && !c.indexCurled && c.pinchRatio < 0.32) {
      this.pinching = true;
      this.h.pinchStart?.();
    } else if (this.pinching && (c.pinchRatio > 0.48 || isFist)) {
      this.pinching = false;
      this.h.pinchEnd?.();
    }

    // 주먹 → 펴기 = 해체
    if (isFist) {
      if (!this.fistSince) this.fistSince = now;
      if (now - this.fistSince > 180) {
        if (!this.armed) this.armedPos = { x: this.x, y: this.y };
        this.armed = true;
        this.armedAt = now;
      }
    } else {
      this.fistSince = 0;
      if (this.armed && isOpen && now - this.armedAt < 900) {
        this.armed = false;
        this.h.burst?.(this.armedPos.x, this.armedPos.y);
      } else if (this.armed && now - this.armedAt >= 900) {
        this.armed = false;
      }
    }

    this.setState(this.pinching ? "pinch" : this.armed ? "fist" : isOpen ? "open" : "hand");
  }
}

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export function drawHand(ctx, lm, state) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const color = state === "pinch" ? "#ffd36b" : state === "fist" ? "#ff6b5a" : "#7be0a6";
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (const [a, b] of BONES) {
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
  }
  ctx.stroke();
  ctx.fillStyle = "#fff";
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
