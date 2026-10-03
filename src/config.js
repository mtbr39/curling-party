// シート寸法・物理定数・色など、全体で共有する定数

// ---------------------------------------------------------------- フィールド
// 大きさと「区間の長さ」だけを決める。各ラインの座標（SHEET）はここから自動で計算される。
// 単位はワールド単位（画面の拡大率とは無関係）。縦方向は手前（ハック側）→奥。
//
//   奥  ┌──────────┐ ← シートの端
//       │  endMargin │
//       ├── BACK ────┤ ← バックライン（ハウスの奥のふち）
//       │   (HOUSE)  │   ハウス半径 × 2
//       ├── HOUSE前 ─┤
//       │ guardZone  │ ← ガードを置くスペース
//       ├── FAR HOG ─┤
//       │  hogToHog  │
//       ├── NEAR HOG ┤
//       │ releaseToHog│
//       │  ● リリース │
//       │ hackToRelease
//       │  ▬ ハック   │
//       │ hackMargin │
//  手前 └──────────┘
export const FIELD = {
  width: 700,                 // シート幅
  houseR: 300,                // ハウス半径（一番外の円）
  ringRatios: [1, 2 / 3, 1 / 3], // ハウスの円の半径の比（本物は 12ft : 8ft : 4ft）
  buttonRatio: 0.106,         // ボタン半径 ÷ ハウス半径（本物は 0.5ft ÷ 6ft ≒ 0.083）
  stoneR: 300/10,                 // ストーン半径（本物の比率だとハウス半径の約 1/12.6）

  hackMargin: 40,             // シートの手前端 → ハック
  hackToRelease: 60,          // ハック → 石のリリース位置
  releaseToHog: 120,          // リリース位置 → 手前のホッグライン
  hogToHog: 400,              // 手前のホッグライン → 奥のホッグライン
  guardZone: 170,             // 奥のホッグライン → ハウスの手前のふち
  endMargin: 60,              // バックライン → シートの奥端
};
// 今の値だと全長 1190 × 幅 460（約 2.6 : 1）

export const SHEET = (() => {
  const f = FIELD;
  const HACK_X = f.hackMargin;
  const SPAWN_X = HACK_X + f.hackToRelease;
  const NEAR_HOG = SPAWN_X + f.releaseToHog;
  const FAR_HOG = NEAR_HOG + f.hogToHog;
  const TEE_X = FAR_HOG + f.guardZone + f.houseR;
  const BACK_X = TEE_X + f.houseR;
  return {
    L: BACK_X + f.endMargin,  // シート全長。x が投げる方向（画面では下→上）
    W: f.width,               // シート幅（画面では左右）
    CY: f.width / 2,          // センターライン
    HACK_X,                   // ハック（投げる人の位置）
    SPAWN_X,                  // 石のリリース位置
    NEAR_HOG,
    FAR_HOG,                  // ここを越えないで止まった石は除外
    TEE_X,                    // ハウス中心
    HOUSE_R: f.houseR,
    RINGS: f.ringRatios.map(k => Math.round(f.houseR * k)),
    BUTTON_R: Math.round(f.houseR * f.buttonRatio),
    BACK_X,                   // 完全に越えたら除外
  };
})();

export const STONE_R = FIELD.stoneR;

export const PHYS = {
  MU: 100,            // 摩擦による減速 (unit/s^2)
  SWEEP_MU: 0.62,     // スイープ中の摩擦倍率
  CURL_K: 20,         // 回転によるカールの強さ
  CURL_V0: 140,       // 低速ほどよく曲がる
  SWEEP_CURL: 0.5,    // スイープ中のカール倍率
  RESTITUTION: 0.93,
  VMAX: 950,
  MAX_ANGLE: 0.3,     // rad
  DT: 1 / 240,
};
// ↑ MU・CURL_K・VMAX などは「速さ 1 倍」のときの値。

// 石の速さの倍率。ここを変えると石の速さが変わる（例: 0.5 = ゆっくり、2 = 速い）。
// 速さを k 倍にすると、同じ道のりを 1/k の時間で進む。摩擦やカールの加速度を k² 倍にすれば、
// 止まる位置も曲がり方もそのまま（時間だけが縮む）。物理はこの倍率を見て自動で調整する。
export const SPEED = { k: 1 };
export const vmax = () => PHYS.VMAX * SPEED.k;

// 投げる強さ(0..1) → 初速。まっすぐ・スイープなしで止まる距離が次の通りになるように決める
//   0%  : 遠いホッグラインに少し届かない
//   20% : ハウスの手前のふちにギリギリ届く
//   90% : バックラインを完全に越える（ここまで距離に比例）
//   90〜100% : テイクアウト用。初速が VMAX まで一気に上がる
const PW = (() => {
  const d0 = SHEET.FAR_HOG - STONE_R - 30 - SHEET.SPAWN_X;
  const d20 = SHEET.TEE_X - SHEET.HOUSE_R - STONE_R + 1 - SHEET.SPAWN_X;
  const d90 = SHEET.BACK_X + STONE_R + 4 - SHEET.SPAWN_X;
  const v = d => Math.sqrt(2 * PHYS.MU * d);
  return { d0, d20, d90, v90: v(d90) };
})();

export function powerToSpeed(p) {
  p = Math.max(0, Math.min(1, p));
  if (p > 0.9) return (PW.v90 + (PHYS.VMAX - PW.v90) * (p - 0.9) / 0.1) * SPEED.k;
  const d = p <= 0.2
    ? PW.d0 + (PW.d20 - PW.d0) * (p / 0.2)
    : PW.d20 + (PW.d90 - PW.d20) * ((p - 0.2) / 0.7);
  return Math.sqrt(2 * PHYS.MU * d) * SPEED.k;
}

export function speedToPower(v) {
  v /= SPEED.k;
  if (v >= PW.v90) return Math.min(1, 0.9 + 0.1 * (v - PW.v90) / (PHYS.VMAX - PW.v90));
  const d = (v * v) / (2 * PHYS.MU);
  if (d <= PW.d20) return Math.max(0, 0.2 * (d - PW.d0) / (PW.d20 - PW.d0));
  return 0.2 + 0.7 * (d - PW.d20) / (PW.d90 - PW.d20);
}

export const RULES = {
  THROW_COOLDOWN: 700,  // ms 同じプレイヤーの連投間隔
  DEADLINE_GRACE: 1500, // ms 期限後、石を消すまで待つ時間（遅れて届く投球を受け付けるため）
  CLOCK_TOLERANCE: 300, // ms 投げた時刻の判定で許す時計のずれ
  SETTLE_WAIT: 1000,    // ms 石が全部止まってから得点計算するまでの待ち
  COUNTDOWN: 3500,      // ms エンド開始前のカウントダウン
  RESULT_TIME: 5500,    // ms エンド結果表示
  HAMMER_TIME: 2,       // ハンマーの最後の一投の持ち時間 = 一投の期限 × この倍率
  BIG_END: 3,           // 1エンドでこの点数以上取ったら「ビッグエンド」
};

export const DEFAULT_SETTINGS = {
  mode: 'solo',        // 'solo' | 'team'
  teamCount: 2,
  stones: 4,
  ends: 4,
  interval: 30,
  stagger: 'auto',
};

const PALETTE = ['#E4572E', '#2B6CB0', '#E8B931', '#2F9E6E', '#7A5BC7', '#1E1E1E', '#E86A9A', '#4FA3B8'];
const NAMES = ['RED', 'BLUE', 'YELLOW', 'GREEN', 'VIOLET', 'BLACK', 'PINK', 'TEAL'];

export function teamColor(i) {
  if (i == null) return '#999';
  if (i < PALETTE.length) return PALETTE[i];
  return `hsl(${(i * 137.5) % 360} 60% 52%)`;
}
export function teamName(i) {
  if (i == null) return '-';
  return NAMES[i] || `TEAM ${i + 1}`;
}
