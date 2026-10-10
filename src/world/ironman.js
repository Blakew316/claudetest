/**
 * Iron Man in place of the spider: the rigged CGTrader suit (see
 * ironman-model.js). The animation is procedural, on a 20-bone driver rig
 * fitted to the model's joints (with clavicles, toes and a knuckle bone,
 * rest pose unrotated); every frame the model's 74 deform bones are turned
 * as the rig's have turned (see drive()), the artist's hover pose blending
 * in while he holds upright in the air.
 *
 * Walking follows human gait: a stride clock with stance ~60% and swing ~40%
 * of the cycle and two double-support phases; the foot rolls heel strike ->
 * foot flat -> heel off (the toes bending flat on the ground) -> toe off; the
 * swing foot is planned to land where the body will be over it at
 * mid-stance; cadence and step length grow with speed as people's do. The
 * pelvis is lowest at double support, shifts over the stance foot, rotates
 * and lists with the stride; the thorax counter-rotates, the arms swing
 * opposite the legs with the elbows flexing, and the head stays level. He
 * starts and stops with settle steps, turns on the spot with pivot steps and
 * stands with breathing, weight shifts and glances when idle. Feet stand on
 * the local ground plane the crawler walks on, slopes included.
 *
 * Shooting: head, then torso and arm come round to the word; the arm extends
 * with a soft elbow, palm out and fingers back like a real repulsor pose,
 * the off hand held ready; standing, he steps into a braced stance. Each
 * blast drives the hand back along the beam (muzzle climb, wrist flick),
 * then the shoulder and torso give. Leaping, he steps round to face his way
 * (quick steps, pivoting on the ball of the planted foot), lowers into the
 * last step and winds up (hips down and back no faster than a body drops on
 * its legs, knees and ankles loading, trunk forward, arms swung back), then
 * drives up hips, knees, heels and toes in turn with the arms swinging
 * through, as hard as the flight climbs, the toes leaving the ground as the
 * knees lock and the jets taking him on from where he left it, moving as he
 * was, timed to the crawler's own launch. Flying: he lifts off upright on his
 * thrusters, pitches into head-first flight as it gets under way (one eased
 * turn: no flips in a dive) with his arms at his sides and his palms back,
 * and swings upright again to brake on his boots before he lands. He lands
 * the superhero way, planned a moment before touchdown: the front foot comes
 * straight down onto its spot, the rear leg folded as it will kneel; the jets
 * cut, his momentum carries him on into a deep kneel and stops there (right
 * knee down, right fist driven into the ground, left arm swept back, head
 * bowed); he holds it, and rises head first, then the chest, then the legs,
 * and walks on. Every contact is met, not slid onto, and held.
 */

import * as THREE from 'three';
import { createRepulsors } from './repulsor.js';
import { JOINT, POSE, MODEL_HEIGHT, loadModel, suitLights } from './ironman-model.js';
import { LAND_TIME } from './spider-sim.js';

const HEIGHT = 46; // world units: he reads at the distances the camera keeps from the crawler
const K = HEIGHT / MODEL_HEIGHT; // world units per model unit (feet at y = 0)
const U = HEIGHT / 2.02; // a body-proportional unit for the few absolute lengths below (tuned on a body 2.02 tall)
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/*
 * The driver rig's joints, in model units (y up, facing +z, his left at +x),
 * from the model's deform bones; heel and toe tip from its feet.
 */
const J = {
  pelvis: JOINT['DEF-spine'],
  spine: JOINT['DEF-spine002'],
  chest: JOINT['DEF-spine003'],
  neck: JOINT['DEF-spine005'],
  crown: [0, MODEL_HEIGHT, 0.1],
  clav: JOINT['DEF-shoulderL'], // sternoclavicular joint: the shoulder girdle shrugs and braces about it
  shoulder: JOINT['DEF-upper_armL'],
  elbow: JOINT['DEF-forearmL'],
  wrist: JOINT['DEF-handL'],
  palm: JOINT['DEF-palm02L'].map((x, i) => (x + JOINT['DEF-f_middle01L'][i]) / 2),
  fingers: JOINT['DEF-f_middle03L'],
  hip: JOINT['DEF-thighL'],
  knee: JOINT['DEF-shinL'],
  ankle: JOINT['DEF-footL'],
  heel: [JOINT['DEF-footL'][0], 0.07, -0.15], // the heel's core
  ball: JOINT['DEF-toeL'], // ball of the foot: the toes bend here
  toe: [JOINT['DEF-toeL'][0], 0.035, 0.44],
  sole: [JOINT['DEF-footL'][0], 0, 0.1],
};
const side = (p, s) => [p[0] * s, p[1], p[2]];
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const L1 = V(J.knee).distanceTo(V(J.hip)); // thigh
const L2 = V(J.ankle).distanceTo(V(J.knee)); // shin
const LU = V(J.elbow).distanceTo(V(J.shoulder)); // upper arm
const LF = V(J.wrist).distanceTo(V(J.elbow)); // forearm
const ANKLE_H = J.ankle[1]; // ankle above the ground (the sole is at y = 0)
const HIP_DROP = J.pelvis[1] - J.hip[1]; // pelvis above the hip joints
const HIP_W = J.hip[0]; // hip joint off the midline
const LEG = J.hip[1]; // hip joint above the ground: the length the gait scales with
// The foot's contact points, from the ground point under the ankle (mesh units, along the foot).
const HEEL_Z = -0.195 - J.ankle[2]; // the back of the heel
const BALL_Z = J.ball[2] - J.ankle[2];
const BALL_Y = J.ball[1]; // the toe joint, which stays put while the heel rises
const TIP_Z = J.toe[2] + 0.03 - J.ankle[2]; // the toe tips, the last of the foot to leave the ground
const HIP_FWD = J.hip[2] - J.pelvis[2]; // the hip joints ahead of the pelvis
const HIP_UP = J.hip[1] - J.pelvis[1]; // ... and above it
// The palm at rest: its normal (the repulsor's axis, from the hand's own bones) and the fingers' direction, left hand.
const KNUCKLE_AT = V(JOINT['DEF-f_middle01L']).sub(V(JOINT['DEF-handL']));
const PALM_N = new THREE.Vector3().crossVectors(KNUCKLE_AT, V(JOINT['DEF-f_index01L']).sub(V(JOINT['DEF-f_pinky01L']))).normalize();
const FINGERS = V(J.fingers).sub(V(J.wrist)).normalize();
// Along the hand (in its plane), across it (toward the thumb), and where the knuckles are from the wrist.
const HAND_ALONG = FINGERS.clone().addScaledVector(PALM_N, -FINGERS.dot(PALM_N)).normalize();
const HAND_ACROSS = new THREE.Vector3().crossVectors(PALM_N, HAND_ALONG);
const KNUCKLES = KNUCKLE_AT.dot(HAND_ALONG);
// The bind pose holds the arms out and a little down (a T-pose); the arm angles below were tuned
// on an A-pose this much lower, so the rig adds the difference.
const ARM_REST_FIX = 1.007 - Math.atan2(J.shoulder[1] - J.wrist[1], J.wrist[0] - J.shoulder[0]);
const ARM_HANG = 0.6; // walking arms hang this much along the world's down rather than the chest's
const ARM_OUT = 0.14; // the arms hang this far out from the sides (rad), clear of the suit
const ARM_PRONATE = 0.3; // ... the palms turned this far from facing the thighs toward the back (rad)
const ELBOW_REST = 0.33; // a relaxed elbow's bend (rad)
// A look somewhere new (more than LOOK_NEW rad away) is one head turn, as a person's is: easing out and in
// (minimum jerk) over LOOK_T[0] + LOOK_T[1] s per rad (a glance ~0.25 s, a big turn ~0.6 s), not a
// constant-speed sweep; once on a word it stays at least LOOK_HOLD (s) before another draws it. The arm
// comes up for a word only once the eyes are on it: it starts after LOOK_LEAD[0], on its way by LOOK_LEAD[1] (s).
const LOOK_NEW = 0.15;
const LOOK_T = [0.22, 0.24];
const LOOK_HOLD = 0.6;
const LOOK_LEAD = [0.25, 0.5];
// Recoil. The hand's kick (spring rad/s, damping) and how far it drives the hand back along the beam
// (share of the arm's reach), climbs the muzzle and flicks the wrist back (rad), at a kick of 1.
const RECOIL_W = 17;
const RECOIL_Z = 0.55;
const RECOIL_BACK = 0.26;
const RECOIL_CLIMB = 0.26;
const RECOIL_FLICK = 0.36;
// ... and the shoulder girdle and trunk giving under it (spring), the trunk turning and rocking back (rad).
const KICK_W = 9;
const KICK_Z = 0.7;
const KICK_TURN = 0.12;
const KICK_ROCK = 0.17;
// ... and the body pushed back along the beams through his legs (leg lengths), the knees giving a little.
const KICK_PUSH = 0.09;
const KICK_SINK = 0.03;

/*
 * The thumb. The model's rest thumb juts out of the palm, which reads as stuck on, so it is posed in the
 * hand's own frame: each segment's direction (metacarpal, proximal, distal) as parts along the fingers,
 * across toward the thumb side, and out of the palm's face (the left hand's frame, mirrored for the right).
 */
const THUMB = {
  relax: [[0.85, 0.3, 0.45], [0.92, 0.0, 0.4], [0.85, -0.22, 0.48]], // resting against the curled index
  open: [[0.68, 0.7, 0.1], [0.8, 0.6, 0.02], [0.9, 0.44, -0.06]], // spread in the palm's plane, to fire
  flat: [[0.88, 0.44, 0.18], [0.95, 0.26, 0.12], [0.97, 0.14, 0.1]], // laid along the index, in flight
};

/** Per hand and pose, each thumb bone's turn from rest in the model's frame (cumulative down the chain). */
function thumbPoses() {
  const out = {};
  for (const n of ['L', 'R']) {
    const m = n === 'L' ? 1 : -1; // mirror x for the right hand
    const mir = (v) => new THREE.Vector3(v.x * m, v.y, v.z);
    const [A, C, N] = [mir(HAND_ALONG), mir(HAND_ACROSS), mir(PALM_N)];
    const t = [1, 2, 3].map((k) => V(JOINT[`DEF-thumb0${k}${n}`]));
    const rest = [t[1].clone().sub(t[0]).normalize(), t[2].clone().sub(t[1]).normalize()];
    rest.push(rest[1]); // the tip carries on from the last joint (straight at rest)
    out[n] = {};
    for (const [pose, dirs] of Object.entries(THUMB)) {
      let acc = new THREE.Quaternion();
      out[n][pose] = dirs.map(([a, c, f], k) => {
        const d = new THREE.Vector3().addScaledVector(A, a).addScaledVector(C, c).addScaledVector(N, f).normalize();
        const from = rest[k].clone().applyQuaternion(acc);
        acc = new THREE.Quaternion().setFromUnitVectors(from, d).multiply(acc);
        return acc.clone();
      });
    }
  }
  return out;
}
const THUMB_Q = thumbPoses();

/* Gait. Times in seconds, lengths in leg lengths (LEG), angles in radians. */
const DS = 0.1; // each double support, as a share of the stride cycle
const SS = 0.5 - DS; // each single support (the other foot swinging)
const TO = { L: 0.5 + DS, R: DS }; // toe-offs in the cycle (heel strikes: L at 0, R at 0.5)
const HS = { L: 0, R: 0.5 };
const BOUNDS = [TO.R, HS.R, TO.L, 1]; // the stride clock's segment ends
const W_STAND = 1.05; // feet apart standing (x the hip joints' spacing)
const W_WALK = 0.62; // walking: closer to the line of progression
const TOE_OUT = 0.1;
const HS_ROLL = -0.3; // the foot's pitch at heel strike (toes up)
// How far back of the flat foot's ankle the ankle is at a full heel strike (rocked on the heel, toes up).
const HS_BACK = -HEEL_Z * (1 - Math.cos(HS_ROLL)) - ANKLE_H * Math.sin(HS_ROLL);
const RISE_MAX = 1.0; // heel rise by toe off (rad)
const TOE_MAX = 0.9; // the toes bend at most this far while the heel rises
const ROLL_RATE = 7; // a planted foot rolls up onto its toes (or back on its heel) at most this fast to keep the leg's reach (rad/s)
// The bind pose's shin leans back: its ankle is this far dorsiflexed (rad). In mid-swing the ankle comes to
// about neutral (+SWING_DORSI), as the foot's turn on the shin.
const REST_DORSI = -Math.atan2(J.ankle[2] - J.knee[2], J.knee[1] - J.ankle[1]);
const SWING_DORSI = 0.07; // (the boots are long: a little toes-up clears them)
const SWING_FOOT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), REST_DORSI - SWING_DORSI);
// The swinging toes stay at least this far off the ground (leg lengths; about a centimetre), the
// ankle turning them up as far as it must, eased in over about this much.
const TOE_CLEAR = 0.012;
const TOE_CLEAR_SOFT = 0.008;
// Setting off briskly the trailing foot leaves the ground before it is further behind the pelvis
// than this (leg lengths; ~0.4 in a steady walk): the steps come quicker, at most this much.
const HURRY_REACH = 0.5;
const HURRY_MAX = 1.8;
const STAGGER = 0.3; // standing, a foot up to this far ahead of its place is a staggered stance, not one to step out of (leg lengths)
const V_GO = 0.2; // leg lengths per second: slower than this he steps only when his feet need it
const APA_T = 0.25; // setting off from standing, he shifts his weight onto the stance foot this long (s) before the first step...
const APA_SHIFT = 0.025; // ... this far (leg lengths)
const APA_V = 0.05; // ... beginning as soon as he starts to move off this fast (leg lengths/s)
const HANG_W = 8; // airborne, the feet come in under him this quickly (rad/s)
const CARRY_W = 30; // how quickly the body takes up a kick in its speed (rad/s): see carry()
const LAND_BLEND = 0.035; // landing, the legs settle from where they reached onto where they stand over about this long (s)
/*
 * The takeoff (times to the launch in s, lengths in leg lengths): Iron Man's, not a jumper's. While the
 * crawler turns to face where it will leap he steps round to face it too; then, his feet under him, he
 * braces: a shallow dip from (at most) CM_LEAD before the launch to its bottom PUSH_T before it (the knees
 * giving a little, his eyes on where he is going), no faster than a body can drop on its own legs
 * (CM_ACC); then the boot jets light and lift him, the legs straightening under him and the heels barely
 * leaving the ground before the toes, his arms going out to his sides palms down to steady him
 * (TAKEOFF_OUT). He rises upright and tips into the flight's head-first attitude only once he is clear.
 * The lift is as strong as the flight climbs (V_LEAP), and the flight takes him from where he left it,
 * not from where the crawler's body is.
 */
const CM_LEAD = 0.7;
const PUSH_T = 0.36;
const CM_BOTTOM = 0.6 * PUSH_T; // the dip bottoms out as the drive gets going
const CM_DROP = 0.12; // the countermovement takes the pelvis this much lower (at most): a brace, not a jumper's crouch (the jets lift him) ...
const CM_BACK = 0.06; // ... and back
const MPS = HEIGHT / 1.8; // a metre (a metre a second) in world units: he is 1.8 m tall
const G_W = 9.81 * MPS; // gravity (world units/s^2)
const CM_ACC = 0.85; // the dip's hardest acceleration (g): it never yanks him down faster than he could fall
const V_LEAP = 3.2 * MPS; // a flight leaving upward this fast (world units/s) gets the full drive ...
const LEAP_MIN = 0.3; // ... and the gentlest still this much of it
const DRIVE_FWD = 0.04; // the drive takes the hips forward this much (at a level departure)
const PIVOT_W = 5; // winding up, a planted foot turns on its ball at most this fast (rad/s) ...
const PIVOT_CAP = 0.5; // ... and, both feet down in the dip, at most this far (rad): more takes a step
const CM_PITCH = [0.06, 0.12, 0.06]; // pelvis, spine and chest pitched forward (rad)
const CM_ARMS = 0.15; // the arms drawn back a little (rad) ...
const PUSH_ARMS = 0.05; // ... and hardly forward by the launch: they go out to his sides, palms down (TAKEOFF_OUT)
const TAKEOFF_OUT = 0.45; // rad out from his sides as the jets lift him, steadying him
const PUSH_ROLL = 0.35; // the heels a little off the ground by the launch (rad): the jets lift him, the toes do not spring him
const TK_HAND = 0.35; // ... and hands back to the flight's own path over this long (s)
const TAKEOFF_W = 2.6; // the flight takes him over from where he left at this rate (rad/s): about a gravity's pull, not a yank
// As the toes leave the ground the ankles ease onto the end of the legs' reach about the hips (this
// much of it) at this rate (rad/s), so the feet are taken up over a few frames as the knees lock, not in one.
const LEAVE_REACH = 0.94;
const LEAVE_W = 28;

/*
 * The three-point landing (times from touchdown in s, lengths in leg lengths unless marked). He comes
 * down upright on his boots and palms, the front (left) foot reaching for the ground; at touchdown he
 * drops into a deep kneel, right knee down, right fist driven into the ground in front of him, left arm
 * swept back and out, head bowed; holds it; then rises head first, then the chest, then the legs, and
 * walks on as the crawler does (LAND_TIME after touchdown). Every contact is placed once, just before
 * touchdown, and reached for; then held: nothing slides.
 */
const LAND_RIDE = 0.7; // the crawler lands riding this far above the surface it lands on
const LAND_G = 0.4; // the flight's pose hands over to the landing's over this long (s): an impact, not a snap
const LAND_RISE = 0.9; // the rise takes this long, ending as the crawler walks on
// The drop into the kneel takes this long (s), less the faster he comes in (s per unit/s of his drop),
// never so short a body would brake harder than its legs can, nor so long it would go past the kneel.
const LAND_DROP = 0.45;
const LAND_DROP_V = 0.001;
// The landing is planned this long before touchdown (s): from then the legs reach for their places (the
// front foot coming straight down onto its spot, the rear leg folded as it will kneel) ...
const APPROACH_T = 0.5;
// ... and his way in is eased to rest on the kneel point by this long after touchdown (s): carried on
// into the kneel by his momentum, never springing back.
const LAND_STOP = 0.42;
const KNEEL_LEAD = 0.12; // the kneeling knee down this far ahead of its hip (the thigh near upright: a right angle at the knee)
const KNEEL_SIT = 0.05; // the pelvis sat back this far
const KNEEL_FRONT = 0.32; // the front ankle this far ahead of its hip (beside the kneeling knee) ...
const KNEEL_WIDE = 0.04; // ... and at least this far out to its side, the knee opening outward
const KNEEL_ROLL = 1.45; // the rear foot up on its bent toes (rad)
const KNEE_PAD = 0.07; // the kneeling knee's joint this far above the ground (mesh units)
// The trunk folded forward (pelvis, spine, chest; rad) only as far as puts the fist on the ground, the
// head bowed a little further: his front stays to the ground ahead of him (the camera sees him from in
// front), not hunched over it ...
const KNEEL_PITCH = [0.35, 0.5, 0.45];
const KNEEL_TURN = 0.15; // ... the trunk turned to the fist, and bent down toward it (rad)
const KNEEL_BEND = 0.45;
const FIST_DROP = 0.5; // ... and the fist's shoulder dropped and brought forward (rad)
const FIST_REACH = 0.97; // the fist's arm this straight (share of its reach)
const FIST_H = 0.2; // its wrist this high over the ground the curled fingers are on (mesh units)
const BLOW = 0.03; // seconds over which a blow (a blast's kick) is delivered
const LAND_BLOW = 0.1; // ... and the landing's, taken by the knees over this long (in a frame it jolted his whole body)
const AIM_W = 13; // an arm whose word has gone coasts to rest at this rate (rad/s, critically damped)
// Onto a new word (more than AIM_NEW rad from the last) the arm makes one decisive move, easing out and in,
// over AIM_T[0] + AIM_T[1] s per rad (at most AIM_T[2]), then holds on it rather than tracking it like a turret.
const AIM_NEW = 0.15;
const AIM_T = [0.22, 0.2, 0.55];
// Proximal to distal: the elbow joins a raise a beat after the shoulder (its spring rad/s raising, lowering),
// bent as the arm comes up (RAISE_FLEX of the reach at most) and straightening to punch out at the end, and
// lets go first as the arm lowers; the wrist follows the elbow. The palm fires once the elbow is AIM_EXT out.
const RAISE_EL_W = [6, 18];
const AIM_RAISE_W = 7; // the shoulder's raise and drop (spring rad/s)
const AIM_DROP_W = 11;
const RAISE_WR_W = [7, 14];
const RAISE_FLEX = 0.3;
const AIM_EXT = 0.8;
// Secondary motion. The trunk lags the body's starts, stops and turns and follows through (an underdamped
// spring on its acceleration: rad per g of SEC_PITCH forward-back, SEC_ROLL sideways), the head nods under
// the body's rise and fall (SEC_NOD rad per g up or down), and leads a turn by SEC_LEAD s of its rate.
// Nothing is ever quite still: a slow, small, irregular drift of the head and chest (LIFE rad), and the
// aiming hand sways a little (AIM_SWAY rad).
const SEC_PITCH = 0.5;
const SEC_ROLL = 0.35;
const SEC_NOD = 0.12;
const SEC_LEAD = 0.22;
const LIFE = 0.022;
const AIM_SWAY = 0.012;
const AIM_UP = 0.45; // ... and never higher than this over the horizontal (rad): higher reads as a wave; the trunk leans back and the palm tips up for the rest
// The words a hand will shoot at (rad, from his heading): across the chest at most REACH_IN, out to its side at most
// REACH_OUT (just past square to the shoulders: further back the arm would wrap behind him), up to REACH_UP over
// AIM_UP and down at most REACH_DOWN. Anything else he only looks at. REACH_HOLD widens it for the word a hand is on.
const REACH_IN = 0.35;
const REACH_OUT = 1.6;
const REACH_UP = 0.35;
const REACH_DOWN = 0.8;
const REACH_HOLD = 0.2;
const AIM_ON = 0.25; // the arm counts as on its word within this (rad): only then does the palm fire
// The ground estimate (see fitGround): how fast it is drawn to the stars on the ground and in the air,
// and how fast the slope it carries him along follows theirs (rad/s).
const GROUND_W = 2.2;
const GROUND_W_AIR = 25;
const GRADE_W = 3.5;
const TIP_STILL = 1; // a crawler's tip moving slower than this (units/s) stands on its star...
const TIP_LIFTED = 0.05; // ... one moving faster is stepping: it counts for this little in his ground
const PELVIS_W = 30; // how quickly a jump in the height the legs allow eases out (rad/s)
const TRACK_V = 0.4; // the fastest the pelvis is carried down with that height (leg lengths/s)
const RISE_V = 0.32; // ... and up (a heavy body pushed up by its legs), leg lengths/s or this share of his speed, the larger
const RISE_SPEED = 0.45;
const PELVIS_W_UP = 18; // a rise beyond that eases in this quickly (rad/s)...
const RISE_GAP = 0.025; // ... from at most this far below (leg lengths): however far it has to go, never with a jolt
const DROP_GAP = 0.025; // ... and down (a drop the legs ask for that is steeper than a body falls still comes smoothly)
// Through double support the stance legs' reach is blended this wide (leg lengths): the body's dip into each step.
const HANDOVER = 0.012;
const HANDOVER_IDLE = 0.004;
const REACH_BLEND = 0.025; // ... and the landing leg's reach blended in this wide: the body starts down before it must
const KNEE_HANG = 0.1; // off the ground the pelvis is carried as high as legs this bent (rad) reach
// Before a heel strike the body comes down onto the landing leg at most this fast (leg lengths/s, /s^2).
const SETTLE_V = 0.1;
const SETTLE_A = 1.5;
// Lifting off higher than the landing leg will reach (stepping down), he is let down to it no
// faster than this (leg lengths/s^2), over at most this much of the swing.
const LET_DOWN_A = 4;
const LET_DOWN_U = 0.85;
const ARRIVE = 0.35; // the swinging foot still comes forward at this share of his speed as the heel strikes
// The swing's lift: u^LIFT_A (1 - u)^LIFT_B, rising from rest and highest about a third of the way
// through (as the knee folds), still a little up as the heel reaches for the ground; scaled by its peak.
const LIFT_A = 1.1;
const LIFT_B = 1.35;
const LIFT_NORM = (LIFT_A / (LIFT_A + LIFT_B)) ** LIFT_A * (LIFT_B / (LIFT_A + LIFT_B)) ** LIFT_B;
const LIFT_CARRY = 0.08; // the heel's rise at toe off carries on into the swing this far (share of the swing), dying away
// The stance knee gives this much more as it takes the weight (rad), most at this share of the stance.
const LOAD_FLEX = 0.24;
const LOAD_PEAK = 0.22;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Share of the way through the landing's rise (LAND_TIME - LAND_RISE .. LAND_TIME) from a to b, eased. */
const riseAt = (t, a, b) => smooth(LAND_TIME - LAND_RISE * (1 - a), LAND_TIME - LAND_RISE * (1 - b), t);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u);
/** |x| and max(0, x) with the corner at 0 rounded over about e: what eases through 0 does not kink there. */
const softAbs = (x, e) => Math.hypot(x, e) - e;
const softPos = (x, e) => (x + softAbs(x, e)) / 2;
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const frac = (x) => x - Math.floor(x);
const hash = (n) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
/** Smooth minimum: like min(a, b) but without a kink (k: the blend width). */
const smin = (a, b, k) => (a + b - Math.sqrt((a - b) * (a - b) + k * k)) / 2;

const _ty = { x: 0, v: 0 }; // scratch for spring.track
const _sv = { x: 0, v: 0 }; // scratch for springing a vector's components
const XYZ = ['x', 'y', 'z'];
const SIDES = ['L', 'R'];

/**
 * Advance a damped spring (x, v) toward a fixed target over dt, solved exactly
 * (no integration error): the same motion at 30, 60 or 144 frames a second,
 * and stable for any stiffness.
 */
function springStep(s, target, w, zeta, dt) {
  const c1 = s.x - target;
  if (zeta >= 0.999) {
    const c2 = s.v + w * c1;
    const e = Math.exp(-w * dt);
    s.x = target + (c1 + c2 * dt) * e;
    s.v = (c2 - w * (c1 + c2 * dt)) * e;
  } else {
    const a = zeta * w;
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const c2 = (s.v + a * c1) / wd;
    const e = Math.exp(-a * dt);
    const co = Math.cos(wd * dt);
    const si = Math.sin(wd * dt);
    s.x = target + e * (c1 * co + c2 * si);
    s.v = e * ((c2 * wd - a * c1) * co - (c1 * wd + a * c2) * si);
  }
}

/**
 * A critically damped (or lightly underdamped) spring toward a target, for every
 * eased value; after a jump in time (a seek) it lands on its target.
 */
function spring(w = 12, zeta = 1, blow = BLOW) {
  const s = { x: 0, v: 0, w, imp: 0 };
  s.to = (target, dt) => {
    if (dt > 0.3) {
      s.x = target;
      s.v = 0;
      s.imp = 0;
      return s.x;
    }
    if (dt <= 0) return s.x;
    // A blow lands over a few milliseconds (as a real one does), not in one frame.
    if (s.imp) {
      const k = 1 - Math.exp(-dt / blow);
      s.v += s.imp * k;
      s.imp -= s.imp * k;
      if (Math.abs(s.imp) < 1e-6) s.imp = 0;
    }
    springStep(s, target, s.w, zeta, dt);
    return s.x;
  };
  /**
   * Follow a moving target (moving at targetV) without lagging it: only the error decays, as a
   * spring's would, so a step in the target still eases in.
   */
  s.track = (target, targetV, dt) => {
    if (dt > 0.3 || dt <= 0) return s.to(target, dt);
    // The target this frame ran from target - targetV dt to target.
    const y = _ty;
    y.x = s.x - target + targetV * dt;
    y.v = s.v - targetV;
    springStep(y, 0, s.w, zeta, dt);
    s.x = target + y.x;
    s.v = targetV + y.v;
    return s.x;
  };
  /** A blow: kicks the value so it peaks near `peak` (from rest) a quarter period later. */
  s.kick = (peak) => (s.imp += peak * s.w * Math.E);
  return s;
}

/** Bones (rest pose: no rotation, so every bone's axes are the mesh's) and their skinning segments. */
function buildSkeleton() {
  const bones = [];
  const segs = [];
  const make = (name, at, parent, seg) => {
    const b = new THREE.Bone();
    b.name = name;
    b.userData.at = at;
    b.position.set(at[0] - (parent ? parent.userData.at[0] : 0), at[1] - (parent ? parent.userData.at[1] : 0), at[2] - (parent ? parent.userData.at[2] : 0));
    if (parent) parent.add(b);
    if (seg) {
      bones.push(b);
      segs.push(seg);
    }
    return b;
  };
  const root = make('pelvis', J.pelvis, null, [J.pelvis, J.spine, 'mid']);
  const spine = make('spine', J.spine, root, [J.spine, J.chest, 'mid']);
  const chest = make('chest', J.chest, spine, [J.chest, J.neck, 'mid']);
  const neck = make('neck', J.neck, chest, [J.neck, J.crown, 'mid']);
  const limbs = {};
  for (const [s, n] of [[1, 'L'], [-1, 'R']]) {
    const clav = make('clav' + n, side(J.clav, s), chest);
    const sh = make('shoulder' + n, side(J.shoulder, s), clav, [side(J.shoulder, s), side(J.elbow, s), 'arm', s]);
    const el = make('elbow' + n, side(J.elbow, s), sh, [side(J.elbow, s), side(J.wrist, s), 'arm', s]);
    const wr = make('wrist' + n, side(J.wrist, s), el, [side(J.wrist, s), side(J.fingers, s), 'arm', s]);
    const palm = make('palm' + n, side(J.palm, s), wr);
    const hip = make('hip' + n, side(J.hip, s), root, [side(J.hip, s), side(J.knee, s), 'leg', s]);
    const knee = make('knee' + n, side(J.knee, s), hip, [side(J.knee, s), side(J.ankle, s), 'leg', s]);
    // The foot from the heel to the ball, so the heel rolls with the foot rather than staying with the shin.
    const ankle = make('ankle' + n, side(J.ankle, s), knee, [side(J.heel, s), side(J.ball, s), 'leg', s]);
    const toe = make('toe' + n, side(J.ball, s), ankle, [side(J.ball, s), side(J.toe, s), 'leg', s]);
    const sole = make('sole' + n, side(J.sole, s), ankle);
    limbs[n] = {
      s, n, clav, sh, el, wr, palm, hip, knee, ankle, toe, sole,
      restUpper: V(side(J.elbow, s)).sub(V(side(J.shoulder, s))).normalize(),
      restFore: V(side(J.wrist, s)).sub(V(side(J.elbow, s))).normalize(),
      restThigh: V(side(J.knee, s)).sub(V(side(J.hip, s))).normalize(),
      restShin: V(side(J.ankle, s)).sub(V(side(J.knee, s))).normalize(),
      // The way the elbow folds at rest: the forearm off the upper arm's line (forward: its crease faces front).
      restFlex: V(side(J.wrist, s)).sub(V(side(J.elbow, s))).normalize().projectOnPlane(V(side(J.elbow, s)).sub(V(side(J.shoulder, s))).normalize()).normalize(),
      palmN: PALM_N.clone().setX(PALM_N.x * s),
      fingers: FINGERS.clone().setX(FINGERS.x * s),
    };
  }
  // The fingers, bending together at the knuckles (skinned apart from the distance weights, see skinFingers).
  for (const n of SIDES) {
    const g = limbs[n];
    g.along = HAND_ALONG.clone().setX(HAND_ALONG.x * g.s);
    g.across = HAND_ACROSS.clone().setX(HAND_ACROSS.x * g.s); // toward the thumb
    g.curlAxis = new THREE.Vector3().crossVectors(g.along, g.palmN).normalize(); // + curls the fingers into the palm
    const f = new THREE.Bone();
    f.name = 'fingers' + n;
    const at = V(side(J.wrist, g.s)).addScaledVector(g.along, KNUCKLES);
    f.userData.at = at.toArray();
    f.position.copy(at).sub(V(side(J.wrist, g.s)));
    g.wr.add(f);
    g.knuckles = f;
    bones.push(f);
  }
  return { root, spine, chest, neck, limbs, bones, segs };
}

/* Scratch for basisQ. */
const _ba = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _bm0 = new THREE.Matrix4();
const _bm1 = new THREE.Matrix4();

/** The rotation taking direction a0 to a1 and, about it, b0 to b1 (b only fixes the roll). */
function basisQ(out, a0, b0, a1, b1) {
  const [x0, y0, z0, x1, y1, z1] = _ba;
  x0.copy(a0).normalize();
  y0.copy(b0).addScaledVector(x0, -b0.dot(x0)).normalize();
  z0.crossVectors(x0, y0);
  x1.copy(a1).normalize();
  y1.copy(b1).addScaledVector(x1, -b1.dot(x1));
  if (y1.lengthSq() < 1e-8) y1.copy(y0).addScaledVector(x1, -y0.dot(x1));
  y1.normalize();
  z1.crossVectors(x1, y1);
  _bm0.makeBasis(x0, y0, z0).transpose();
  _bm1.makeBasis(x1, y1, z1).multiply(_bm0);
  return out.setFromRotationMatrix(_bm1);
}

/**
 * @param {THREE.WebGLRenderer} renderer for the suit's reflections
 * @returns {{group: THREE.Group, fx: THREE.Group, update: Function, chest: Function, up: Function, debug: Function}}
 */
export function createIronMan(renderer) {
  const group = new THREE.Group(); // at his pelvis
  const body = new THREE.Group(); // oriented: +y his head, +z his chest
  group.add(body);
  const repulsors = createRepulsors();
  const fx = repulsors.group; // world-space effects: rays, flares, sparks

  // The driver rig and the model's own deform bones, which follow it every frame (see drive());
  // both live in model space.
  const sk = buildSkeleton();
  const rig = new THREE.Group(); // model units, pivoted at the pelvis
  rig.scale.setScalar(K);
  rig.position.set(0, -J.pelvis[1] * K, -J.pelvis[2] * K); // the pelvis on his origin, so the feet are planned under the hips
  const holder = new THREE.Object3D();
  holder.add(sk.root);
  rig.add(holder);
  body.add(rig);
  let model = null;
  loadModel(renderer, (m) => {
    rig.add(m.scene);
    model = rigModel(m);
  }, group);
  const pelvisY0 = sk.root.position.y;

  // Lights for the suit (see suitLights): a warm key over the camera's shoulder casting his own shadows, cool
  // rims from behind, a soft fill; they and the reflected studio follow the camera round him.
  const lights = suitLights(renderer, body);
  const repulsorLight = new THREE.PointLight(0x9fdcff, 0, 60 * U / 22, 2); // the repulsors light up his own armour
  group.add(lights.group, repulsorLight);

  /* ---------------- state ---------------- */

  const footState = () => ({
    swing: null,
    pos: new THREE.Vector3(), // planted: the ground point under the ankle (world)
    nrm: new THREE.Vector3(0, 1, 0), // the ground's normal there
    yaw: 0,
    rho: 0, // pitch: > 0 heel up (rolling over the ball), < 0 toes up (rocking on the heel)
    rock: 0, // the heel-strike pitch, rolled out over the loading response
    landT: -9,
    toe: 0, // the toes' bend (flat on the ground while the heel rises)
    sigma: 0, // progress through stance (0 heel strike, 1 toe off)
    rhoLo: 0, // the roll it has and may take this frame
    rhoHi: 0,
    flex: 0.087, // the knee bend its leg should have
    ankle: new THREE.Vector3(), // where the ankle is this frame (world)
    last: new THREE.Vector3(), // ... and last frame, for its velocity
    vel: new THREE.Vector3(),
    q: new THREE.Quaternion(), // the foot's orientation this frame (world)
    blend: new THREE.Vector3(), // landing: where the ankle was reaching, less where it is planted (eased out)
    blendT: -9,
    blendTau: LAND_BLEND, // ... over about this long
    pole: new THREE.Vector3(), // the knee's way (world), taken this much over the foot's own (the kneeling leg's)
    poleW: 0,
    raise: new THREE.Vector3(), // landing: the ankle held this far off its place (world), coming down with the body
    off: new THREE.Vector3(), // the ankle from its hip (world axes), and how fast that changes: the leap hands it over
    offV: new THREE.Vector3(),
    leaving: false, // taking off: the toes leaving the ground
    piv: 0, // winding up: how far it has turned on its ball since the dip began (rad)
    rhoDrawn: 0, // its roll as drawn last frame
  });
  const swingState = () => ({ u: 0, v0: 0, v1: 0, vy0: 0, m0: -1, mU: 1, tipOff: 0, a0: new THREE.Vector3(), a1: new THREE.Vector3(), yaw0: 0, rho0: 0, toe0: 0, n0: new THREE.Vector3(), tPos: new THREE.Vector3(), tNrm: new THREE.Vector3(), tYaw: 0, tRho: HS_ROLL, lift: 0, rel0: new THREE.Quaternion() });
  const st = {
    phase: TO.L, // the stride clock (0..1): L heel strike at 0, R toe off DS, R heel strike 0.5, L toe off 0.5 + DS
    holding: true, // stopped at a toe off: standing
    prep: -1, // setting off: time left shifting the weight before the first step
    prepFoot: null, // ... and the foot that will take it
    feet: null,
    swings: { L: swingState(), R: swingState() },
    grounded: true,
    time: 0,
    gx: 0, // ground gradient under him (dy/dx, dy/dz)
    gz: 0,
    yawRate: 0,
    prevYaw: null,
    acc: new THREE.Vector3(),
    prevV: new THREE.Vector3(),
    aim: { L: { id: -1, fresh: -9, born: -9, has: false, dir: new THREE.Vector3(0, 0, 1), dirS: new THREE.Vector3(), dirV: new THREE.Vector3(), seen: 0 }, R: { id: -1, fresh: -9, born: -9, has: false, dir: new THREE.Vector3(0, 0, 1), dirS: new THREE.Vector3(), dirV: new THREE.Vector3(), seen: 0 } },
    seen: new Map(), // word id -> {t: first seen, p: last reach}
    landDipArmed: false,
    look: { y: 0, p: 0, y0: 0, p0: 0, y1: 0, p1: 0, T0: -9, T: 0.3 }, // the head's look, and the turn it is making (from y0/p0 to y1/p1 since T0, over T)
    lookId: -1, // the word the head is on, since lookT
    lookT: -9,
    aimHigh: { L: 0, R: 0 }, // how far over AIM_UP each arm's word is (rad, by its aim's weight)
  };
  const ez = {
    walk: spring(5), fly: spring(9), air: spring(9), crouch: spring(10, 0.9), att: spring(9), hover: spring(6),
    speed: spring(6), active: spring(6), pelvisY: spring(PELVIS_W), sway: spring(9, 0.9), land: spring(9, 0.55, LAND_BLOW),
    hips: spring(5, 0.9), twist: spring(7, 0.9), lookY: spring(8, 0.9), lookP: spring(8, 0.9),
    shift: spring(1.6, 0.9), brace: spring(4, 0.9), wide: spring(4, 0.9), lean: spring(5, 0.9),
    arm: { L: spring(14, 0.7), R: spring(14, 0.7) }, elbow: { L: spring(10, 0.55), R: spring(10, 0.55) }, aim: { L: spring(7, 0.75), R: spring(7, 0.75) }, aimEl: { L: spring(6, 0.85), R: spring(6, 0.85) }, secP: spring(6, 0.45), secR: spring(6, 0.45), nod: spring(8, 0.4), lead: spring(5, 0.8), aimWr: { L: spring(7, 0.9), R: spring(7, 0.9) }, guard: { L: spring(6, 0.9), R: spring(6, 0.9) },
    gx: spring(GRADE_W), gz: spring(GRADE_W), gOff: spring(GROUND_W), hV: spring(40), pushX: spring(11, 0.9), pushZ: spring(11, 0.9), apa: spring(10),
    hurry: spring(10), elev: spring(7), go: spring(14), ext: spring(6),
    // A blast's kick through the arm: back along the beam within ~50 ms, a touch past rest on the
    // way back, settled by ~0.25 s; and its push through the shoulder and torso, a beat later and slower.
    recoil: { L: spring(RECOIL_W, RECOIL_Z), R: spring(RECOIL_W, RECOIL_Z) },
    kick: { L: spring(KICK_W, KICK_Z), R: spring(KICK_W, KICK_Z) },
  };
  ez.elbow.L.x = ez.elbow.R.x = ELBOW_REST; // (relaxed from the first frame)
  ez.hurry.x = 1;
  const heading = new THREE.Vector3(0, 0, 1);
  const leftV = new THREE.Vector3(1, 0, 0);
  const head = new THREE.Vector3(0, 1, 0);
  const bodyQ = new THREE.Quaternion(); // the body's turn this frame is eased toward
  const X = new THREE.Vector3();
  const v = new THREE.Vector3();
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();
  const d3 = new THREE.Vector3();
  const e3 = new THREE.Vector3();
  const f3 = new THREE.Vector3();
  const pxz = new THREE.Vector3(); // the point on the ground under his pelvis
  const hipW = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const q3 = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const rootQ = new THREE.Quaternion();
  const inv = new THREE.Matrix4();
  const flightQ = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const palms = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const landFrom = { L: [0, 0, 0], R: [0, 0, 0] };
  const anc = new THREE.Vector3(); // the point on the ground he is carried over (see update)
  const qBody = new THREE.Quaternion();
  const qLegG = [0, 1, 2, 3].map(() => new THREE.Quaternion()); // scratch: a leg's bones on the ground, in flight, in the air
  const qLegF = [0, 1, 2, 3].map(() => new THREE.Quaternion());
  const qLegA = [0, 1, 2, 3].map(() => new THREE.Quaternion());

  /* ---------------- the three-point landing ---------------- */

  // Placed at touchdown: the ground he lands on, his heading then, the drop he comes in with, the
  // kneeling knee's and the fist's places on the ground; and his height, for the drop's speed.
  const ld = { on: false, t: 0, ground: 0, h: new THREE.Vector3(), l: new THREE.Vector3(), h0: NaN, v0: 0, T: LAND_DROP, hK0: NaN, knee: new THREE.Vector3(), fist: new THREE.Vector3(), wrist: new THREE.Vector3(), lastY: 0, vy: 0, lastPH: 0,
    // Planned on the way down (APPROACH_T before touchdown): where he will kneel (K, on the crawler's landing
    // point), how high the kneel holds his pelvis over the ground (kneelH), the feet's places (fp: foot states,
    // planted), and his horizontal path into the kneel (a cubic from his way in to rest on K: no rebound).
    // (approached: the legs reached their places before touchdown; drop: the pelvis over the kneel, for the rear leg.)
    plan: false, approached: false, K: new THREE.Vector3(), rStand: new THREE.Vector3(), kneelH: 0, fp: null, ap: null, a0: new THREE.Vector3(), av: new THREE.Vector3(), aT0: 0, aT: 1, drop: 0 };
  // The leap: how deep in the countermovement (cm), how far through the drive (push), the heels'
  // roll, the arms' swing; and, from the launch, the flight taking him over from where he left.
  // (t0: the countdown when the dip began, -1 before; depth: how deep it goes (leg lengths); drive: how hard
  // the push is, by how steeply the flight climbs; fwd: how much of the departure is forward.)
  const JW = { cm: 0, push: 0, unfold: 0, rise: 0, heel: 0, arms: 0, out: 0, t0: -1, depth: CM_DROP, drive: 1, fwd: 0 };
  const tk = { on: false, t: 0, T: 1, off: new THREE.Vector3(), offV: new THREE.Vector3(), v: new THREE.Vector3(), last: new THREE.Vector3(), p0: new THREE.Vector3(), vL: new THREE.Vector3(), aL: new THREE.Vector3(), dp: new THREE.Vector3(), dpT: 0, gap: new THREE.Vector3(), gapT: -9 };

  /**
   * The leap's parts in time (into JW).
   * @param {number} tl seconds until the launch (< 0: not winding up)
   * @param {number} dur the whole wind-up (s)
   * @param {number} tA seconds since the launch (< 0: not just launched)
   * @param {boolean} ready his feet are down and turned his way: the dip may begin
   * @param {number[]} launchV the way the flight heads off (world units/s)
   * @param {number} rise how fast the flight climbs over its first moments (world units/s, < 0 diving)
   * @param {number} lam leg length (world)
   * @param {boolean} jumped a jump in time (a seek): the dip as if begun on time
   */
  function jumpWeights(tl, dur, tA, ready, launchV, rise, lam, jumped) {
    if (tl >= 0) {
      // The dip begins once he has stepped round to face his way and his feet are coming under him (or
      // there is no more time to wait), as deep as the time left lets a body drop on its legs (min-jerk:
      // peak acceleration 5.77 x depth / time^2). Its bottom is the drive's start: no pause there.
      const lead = Math.min(CM_LEAD, Math.max(dur, PUSH_T + 0.12));
      if (jumped) JW.t0 = -1;
      if (JW.t0 < 0 && tl <= lead && (ready || jumped || tl <= PUSH_T + 0.16)) {
        JW.t0 = jumped ? lead : Math.max(tl, PUSH_T + 0.04);
        const T = JW.t0 - CM_BOTTOM;
        const speed = Math.hypot(launchV[0], launchV[1], launchV[2]);
        JW.drive = clamp(rise / V_LEAP, LEAP_MIN, 1);
        JW.fwd = speed > 1e-3 ? clamp(Math.hypot(launchV[0], launchV[2]) / speed, 0, 1) : 0;
        JW.depth = Math.min(CM_DROP * (0.25 + 0.75 * JW.drive), (CM_ACC * G_W * T * T) / 5.77 / lam);
      }
      JW.cm = JW.t0 < 0 ? 0 : minJerk(clamp((JW.t0 - tl) / (JW.t0 - CM_BOTTOM), 0, 1));
      JW.push = clamp((PUSH_T - tl) / PUSH_T, 0, 1);
    } else if (tA >= 0) {
      JW.cm = 1;
      JW.push = 1;
    } else {
      JW.cm = JW.push = JW.unfold = JW.rise = JW.heel = JW.arms = JW.out = 0;
      JW.t0 = -1;
      return JW;
    }
    const p = JW.push;
    // Hips first, then the knees (speeding up to the launch), then the heels and toes.
    JW.unfold = smooth(0, 0.8, p);
    const k = clamp((p - 0.1) / 0.9, 0, 1);
    JW.rise = k * k;
    const h = clamp((p - 0.45) / 0.55, 0, 1);
    JW.heel = PUSH_ROLL * (0.3 + 0.7 * JW.drive) * h * h + (tA >= 0 ? 0.6 * smooth(0, 0.12, tA) : 0); // (on over the toe tips as they leave)
    // The arms: back with the dip, then through and up with the drive, and on into the flight.
    JW.arms = -CM_ARMS * JW.cm * (1 - smooth(0, 0.6, p)) + PUSH_ARMS * smooth(0.15, 0.95, p) * (tA >= 0 ? 1 - smooth(0, 0.3, tA) : 1);
    // ...and out to his sides, palms down, as the jets light and lift him (into the flight's own pose after).
    JW.out = TAKEOFF_OUT * smooth(0.1, 0.8, p) * (tA >= 0 ? 1 - smooth(0.2, 0.6, tA) : 1);
    return JW;
  }

  /**
   * The launch: the flight takes him over from where he is drawn, moving as he is (rising off his
   * legs), not from where the crawler's body is: the difference in speed dies away over the first
   * moments of the flight, as the jets take him (about a gravity's pull, never a yank), and the
   * difference in height (he leaves standing tall; the crawler crouched) over its first half.
   * @param {object} spider the crawler as drawn
   * @param {number} dt frame time (s)
   */
  function beginTakeoff(spider, dt) {
    tk.on = true;
    tk.t = 0;
    // (On the crawler's flight path itself, which is smooth from its launch (its drawn body's pose springs
    // back out of the crouch as it goes, which he has no part in), as it leaves taken from its launch
    // speed and curve: as drawn it is a step late getting under way.)
    tk.vL.fromArray(spider.launchV);
    tk.aL.fromArray(spider.launchA);
    carriedTk.set = false;
    tk.p0.fromArray(spider.p);
    tk.off.copy(group.position).addScaledVector(tk.v, dt).sub(tk.p0);
    tk.offV.copy(tk.v).sub(tk.vL);
    tk.T = clamp(0.45 * (spider.airDur || 2), 0.6, 1.1);
  }

  // How far into the pose each part is (0..1), by time from touchdown (see landWeights).
  const LW = { on: 0, torso: 0, head: 0, fist: 0, arm: 0, rise: 0, step: 0 };

  /**
   * The landing's parts in time: the trunk folds and the head bows as he takes the impact, the fist
   * is driven down just as the knee lands, the left arm sweeps back; rising, the head comes up first,
   * then the chest, the fist leaves the ground, and the legs push him up as the rear heel comes down.
   * @param {number} t seconds since touchdown (< 0: not landing)
   */
  function landWeights(t) {
    if (t < 0) {
      LW.on = LW.torso = LW.head = LW.fist = LW.arm = LW.rise = LW.step = 0;
      return LW;
    }
    LW.on = smooth(0, LAND_G, t);
    // (Rising: the head comes up first and the fist leaves the ground; the chest stays over the front foot
    // until the legs are well into their push, and comes up with it; the rear foot steps in under him.)
    // (Spread so nothing is snapped: the fist took 0.14 s from the flight pose to the ground, ~20 g.)
    LW.torso = smooth(0, 0.45, t) * (1 - riseAt(t, 0.25, 0.8));
    LW.head = smooth(0.05, 0.5, t) * (1 - riseAt(t, 0.1, 0.55));
    LW.fist = smooth(0, 0.36, t) * (1 - riseAt(t, 0.1, 0.6));
    LW.arm = smooth(0, 0.6, t) * (1 - riseAt(t, 0.15, 0.75));
    LW.rise = minJerk(clamp((t - (LAND_TIME - 0.75 * LAND_RISE)) / (0.75 * LAND_RISE), 0, 1));
    LW.step = clamp((t - (LAND_TIME - 0.55 * LAND_RISE)) / (0.55 * LAND_RISE - 0.08), 0, 1);
    return LW;
  }

  /** The trunk folded over the kneel by w (onto the rotations already set): forward, turned and bent toward the fist. */
  function foldTrunk(w) {
    sk.root.rotation.x += KNEEL_PITCH[0] * w;
    sk.spine.rotation.x += KNEEL_PITCH[1] * w;
    sk.spine.rotation.y += 0.5 * KNEEL_TURN * w;
    sk.spine.rotation.z += 0.5 * KNEEL_BEND * w;
    sk.chest.rotation.x += KNEEL_PITCH[2] * w;
    sk.chest.rotation.y += 0.5 * KNEEL_TURN * w;
    sk.chest.rotation.z += 0.5 * KNEEL_BEND * w;
  }

  /**
   * Plan the landing, on the way down (APPROACH_T before touchdown) or, with no way down to plan it on,
   * at touchdown. He will kneel on the crawler's landing point, K. The body is set, for a moment, where
   * it will kneel and folded as it will be, to find where its parts meet the ground: the right knee ahead
   * of its hip (the thigh reaching down from the low pelvis), the right foot behind it up on its toes
   * (the shin back along the ground), the left foot well ahead, the right fist below and ahead of its
   * shoulder. These places hold until he walks on: the legs reach for them before touchdown, so nothing
   * is snatched onto its place or slid along the ground after it. His way in is a cubic from where he
   * is, moving as he is, to rest on K a moment after touchdown (his momentum carries him on into the
   * kneel; he never springs back against it).
   * @param {object} spider the crawler as drawn
   * @param {number} Ks mesh scale
   * @param {number} lam leg length (world)
   * @param {number} tRem seconds to touchdown (0: touching down now)
   * @param {boolean} seek a jump in time into the landing: already kneeling
   */
  function planLanding(spider, Ks, lam, tRem, seek) {
    ld.plan = true;
    const at = spider.airDur > 0 ? spider.landAt : spider.p;
    ld.ground = at[1] - LAND_RIDE * lam;
    ld.h.copy(heading);
    ld.l.copy(leftV);
    ld.K.set(at[0], 0, at[2]).addScaledVector(ld.h, -KNEEL_SIT * lam); // (sat back over the rear heel)
    if (seek) {
      ld.a0.copy(ld.K);
      ld.av.set(0, 0, 0);
    } else {
      // (From where he is carried and as he is moving, less his body's own sway over the crawler's path.)
      ld.a0.set(group.position.x - (spider.b[0] - spider.p[0]), 0, group.position.z - (spider.b[2] - spider.p[2])).addScaledVector(tk.v, 1 / 60);
      ld.av.set(tk.v.x, 0, tk.v.z);
    }
    ld.aT0 = st.time;
    ld.aT = tRem + LAND_STOP;
    const yaw = Math.atan2(heading.x, heading.z);
    // The kneel, provisionally (upright on his heading; the pelvis a slanting thigh over the kneeling knee).
    qBody.copy(body.quaternion);
    body.quaternion.setFromAxisAngle(UP, yaw);
    const kneeOff = (KNEEL_LEAD * lam) / Ks;
    ld.kneelH = (Math.sqrt(L1 * L1 - kneeOff * kneeOff) + KNEE_PAD - HIP_UP) * Ks;
    group.position.set(ld.K.x, ld.ground + ld.kneelH, ld.K.z);
    sk.root.position.y = pelvisY0;
    sk.root.rotation.set(0, 0, 0);
    sk.spine.rotation.set(0, 0, 0);
    sk.chest.rotation.set(0, 0, 0);
    foldTrunk(1);
    sk.limbs.R.clav.rotation.set(0, -sk.limbs.R.s * FIST_DROP, -sk.limbs.R.s * FIST_DROP);
    group.updateMatrixWorld(true);
    if (!ld.fp) {
      ld.fp = { L: footState(), R: footState() };
      ld.ap = { L: footState(), R: footState() }; // (scratch for the legs' reach on the way down)
    }
    const fR = ld.fp.R;
    const fL = ld.fp.L;
    // Right: the knee down ahead of its hip; the foot behind it, up on its toes.
    sk.limbs.R.hip.getWorldPosition(hipW);
    ld.knee.set(hipW.x, ld.ground + KNEE_PAD * Ks, hipW.z).addScaledVector(ld.h, KNEEL_LEAD * lam);
    for (const n of SIDES) {
      const f = ld.fp[n];
      f.swing = null;
      f.nrm.copy(UP);
      f.yaw = yaw + (n === 'L' ? TOE_OUT : -TOE_OUT);
      f.sigma = 0.5;
      f.rock = 0;
      f.rhoLo = 0;
      f.blendT = -9;
      f.raise.set(0, 0, 0);
    }
    fR.pos.set(0, 0, 0);
    ankleAt(fR, KNEEL_ROLL, Ks, c3); // its ankle from its ground point, up on its toes
    const shin = L2 * Ks;
    const dyA = clamp(c3.y - KNEE_PAD * Ks, 0, shin);
    const back = Math.sqrt(shin * shin - dyA * dyA);
    fR.pos.set(ld.knee.x - ld.h.x * back - c3.x, ld.ground, ld.knee.z - ld.h.z * back - c3.z);
    fR.rho = fR.rhoHi = KNEEL_ROLL;
    fR.toe = TOE_MAX;
    fR.pole.copy(ld.h);
    // Left: the foot well ahead of its hip and out to its side, the knee up and open beside the chest.
    sk.limbs.L.hip.getWorldPosition(hipW);
    fL.pos.set(hipW.x, ld.ground, hipW.z).addScaledVector(ld.h, KNEEL_FRONT * lam).addScaledVector(ld.l, KNEEL_WIDE * lam);
    fL.rho = fL.rhoHi = fL.toe = 0;
    // (Where the rear foot steps in to as he rises: under him, beside and a little behind the front foot.)
    ld.rStand.set(at[0], ld.ground, at[2]).addScaledVector(ld.l, -HIP_W * W_STAND * Ks).addScaledVector(ld.h, -0.06 * lam);
    fL.pole.copy(ld.h).addScaledVector(UP, 1.5).addScaledVector(ld.l, 0.8).normalize();
    for (const n of SIDES) {
      ld.fp[n].poleW = 1;
      poseStance(ld.fp[n], Ks);
    }
    // The fist: below and ahead of the right shoulder (out a little), as far as the arm reaches.
    sk.limbs.R.sh.getWorldPosition(b3);
    const drop = b3.y - (ld.ground + FIST_H * Ks);
    const reach = FIST_REACH * (LU + LF) * Ks;
    const out = Math.sqrt(Math.max(0, reach * reach - drop * drop));
    c3.copy(ld.h).multiplyScalar(0.55).addScaledVector(ld.l, -0.45).normalize();
    ld.fist.set(b3.x, ld.ground, b3.z).addScaledVector(c3, out);
    body.quaternion.copy(qBody);
    group.updateMatrixWorld(true);
  }

  /** His horizontal way into the kneel at time t (into out, y untouched): the planned cubic, then at rest on K. */
  function landPath(t, out) {
    const T = ld.aT;
    const u = clamp((t - ld.aT0) / T, 0, 1);
    const h01 = u * u * (3 - 2 * u);
    const h10 = u * (1 - u) * (1 - u) * T;
    out.x = ld.a0.x + (ld.K.x - ld.a0.x) * h01 + ld.av.x * h10;
    out.z = ld.a0.z + (ld.K.z - ld.a0.z) * h01 + ld.av.z * h10;
    return out;
  }

  /**
   * How high over the landing's ground the pelvis puts the kneeling knee on the ground, its thigh
   * reaching down to it from the right hip where it is now (world; the pelvis at group.position).
   */
  function kneelAt(hip, Ks) {
    const thigh = 0.99 * L1 * Ks;
    const kx = hip.x - ld.knee.x;
    const kz = hip.z - ld.knee.z;
    return ld.knee.y + Math.sqrt(Math.max(0, thigh * thigh - kx * kx - kz * kz)) - (hip.y - group.position.y) - ld.ground;
  }

  /**
   * Coming down into the kneel, the rear foot is held off its place (into out) as the pelvis is above
   * the kneel (up): it comes down folded with the body, and along with it while it is well clear of the
   * ground (so a pelvis still on its way to the kneel point does not drag it), onto its place as the
   * knee goes down.
   */
  function rearRaise(out, up) {
    const lam = LEG * K;
    landPath(ld.aT0 + ld.aT, out); // (where the pelvis comes to rest, horizontally)
    const rigid = smooth(0.05 * lam, 0.3 * lam, up);
    return out.set((group.position.x - out.x) * rigid, up, (group.position.z - out.z) * rigid);
  }

  /**
   * Touchdown: take up the landing planned on the way down (or plan it now). The feet are on their
   * places already (see the approach in update()), so they are simply planted there.
   * @param {object} spider the crawler as drawn
   * @param {number} Ks mesh scale
   * @param {number} lam leg length (world)
   * @param {boolean} seek a jump in time into the landing: no drop to take, already kneeling
   */
  function beginLanding(spider, Ks, lam, seek) {
    const approached = ld.plan && !seek;
    if (!approached) planLanding(spider, Ks, lam, 0, seek);
    ld.on = true;
    ld.approached = approached || seek;
    ld.h0 = seek ? NaN : group.position.y - ld.ground;
    ld.v0 = seek ? 0 : ld.vy;
    ld.hK0 = NaN;
    st.grounded = true;
    st.holding = true;
    st.phase = TO.L;
    st.prep = -1;
    st.prepFoot = null;
    st.landDipArmed = false;
    for (const n of SIDES) {
      const f = st.feet[n];
      const p = ld.fp[n];
      // (Where the foot is drawn, carried on by its speed: what it settles from, if it was not already reaching for its place.)
      sk.limbs[n].ankle.getWorldPosition(b3).addScaledVector(f.vel, approached || seek ? 0 : 1 / 60);
      f.swing = null;
      f.pos.copy(p.pos);
      f.nrm.copy(UP);
      f.yaw = p.yaw;
      f.rho = f.rhoHi = p.rho;
      f.rhoLo = 0;
      f.toe = p.toe;
      f.sigma = 0.5;
      f.rock = 0;
      f.landT = st.time;
      f.pole.copy(p.pole);
      f.poleW = 1;
      f.raise.set(0, 0, 0);
      poseStance(f, Ks);
      f.blendTau = 0.08;
      f.blendT = approached || seek ? -9 : st.time;
      f.blend.copy(b3).sub(f.ankle);
    }
  }
  const soles = [new THREE.Vector3(), new THREE.Vector3()];
  const aimW = { L: 0, R: 0 };
  const aimGoal = { L: new THREE.Vector3(0, 0, 1), R: new THREE.Vector3(0, 0, 1) }; // where each arm is heading
  const aimOn = { L: false, R: false }; // each arm on its word (it may fire)
  for (const n of SIDES) Object.assign(st.aim[n], { mFrom: new THREE.Vector3(0, 0, 1), mTo: new THREE.Vector3(0, 0, 1), mT0: -9, mT: 0.3 }); // the arm's move onto its word
  const _m1 = new THREE.Vector3();
  const _m2 = new THREE.Vector3();
  const fxIn = { palms, soles, head, vel: v, aim: aimW };
  const AX = new THREE.Vector3(1, 0, 0);
  const AY = new THREE.Vector3(0, 1, 0);
  const AZ = new THREE.Vector3(0, 0, 1);

  const perp = (a, n, fallback) => {
    a.addScaledVector(n, -a.dot(n));
    if (a.lengthSq() < 1e-6) a.copy(fallback).addScaledVector(n, -fallback.dot(n));
    return a.normalize();
  };

  /* ---------------- ground ---------------- */

  /**
   * The ground he stands on: the plane through the crawler's leg tips (the
   * surface of the ball it walks), so his feet climb and descend its slopes.
   * The tips are stars and the crawler's own feet step, so the raw plane
   * wobbles by units from step to step: on the ground its height is carried
   * along the eased slope as he travels over it and only drawn toward the
   * fitted plane slowly (critically damped), so none of that wobble reaches
   * his body; in the air it follows the fit closely, ready for the landing.
   */
  function fitGround(spider, dt, g) {
    const raw = rawGround(spider, dt);
    if (dt > 0.3 || st.gy === undefined) {
      st.gx = ez.gx.x = raw.gx;
      st.gz = ez.gz.x = raw.gz;
      ez.gx.v = ez.gz.v = 0;
      st.gPred = raw.y;
      ez.gOff.x = ez.gOff.v = 0;
      st.gy = raw.y;
      st.gpx = spider.p[0];
      st.gpz = spider.p[2];
      return;
    }
    // Carried along the slope he walks over (dy = grade . dx)...
    st.gPred += st.gx * (spider.p[0] - st.gpx) + st.gz * (spider.p[2] - st.gpz);
    st.gpx = spider.p[0];
    st.gpz = spider.p[2];
    st.gx = ez.gx.to(raw.gx, dt);
    st.gz = ez.gz.to(raw.gz, dt);
    // ... and drawn to the fit: slowly on the ground, at once in the air.
    ez.gOff.w = GROUND_W + (GROUND_W_AIR - GROUND_W) * g;
    st.gy = st.gPred + ez.gOff.to(raw.y - st.gPred, dt);
  }

  /**
   * The least-squares plane through the crawler's leg tips: its gradient and its height under his
   * pelvis. The tips standing on stars count; the ones lifted and stepping (moving since last
   * frame) hardly do, or every step of the crawler's would lift his ground.
   */
  const rawG = { gx: 0, gz: 0, y: 0 };
  const tipW = new Float32Array(64);
  const tipLast = new Float32Array(64 * 3);
  let tipsSeen = 0;
  function rawGround(spider, dt) {
    const L = spider.legs;
    const n = Math.min(L.length, 64);
    let ws = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < n; i++) {
      const t = L[i].tip;
      const moved = Math.hypot(t[0] - tipLast[i * 3], t[1] - tipLast[i * 3 + 1], t[2] - tipLast[i * 3 + 2]);
      const w = tipsSeen === n && dt > 0 && dt < 0.3 && moved > TIP_STILL * dt ? TIP_LIFTED : 1;
      tipW[i] = w;
      tipLast[i * 3] = t[0];
      tipLast[i * 3 + 1] = t[1];
      tipLast[i * 3 + 2] = t[2];
      ws += w;
      mx += w * t[0];
      my += w * t[1];
      mz += w * t[2];
    }
    tipsSeen = n;
    mx /= ws;
    my /= ws;
    mz /= ws;
    let sxx = 0;
    let sxz = 0;
    let szz = 0;
    let sxy = 0;
    let szy = 0;
    for (let i = 0; i < n; i++) {
      const t = L[i].tip;
      const w = tipW[i];
      const x = t[0] - mx;
      const y = t[1] - my;
      const z = t[2] - mz;
      sxx += w * x * x;
      sxz += w * x * z;
      szz += w * z * z;
      sxy += w * x * y;
      szy += w * z * y;
    }
    const det = sxx * szz - sxz * sxz;
    let gx = 0;
    let gz = 0;
    if (det > 1e-3) {
      gx = (sxy * szz - szy * sxz) / det;
      gz = (szy * sxx - sxy * sxz) / det;
    }
    // A man walks up a 40 degree slope at most.
    const g = Math.hypot(gx, gz);
    if (g > 0.84) {
      gx *= 0.84 / g;
      gz *= 0.84 / g;
    }
    rawG.gx = gx;
    rawG.gz = gz;
    rawG.y = my + gx * (spider.p[0] - mx) + gz * (spider.p[2] - mz); // under his pelvis
    return rawG;
  }
  const groundAt = (x, z) => st.gy + st.gx * (x - pxz.x) + st.gz * (z - pxz.z);
  const groundN = (out) => out.set(-st.gx, 1, -st.gz).normalize();

  /* ---------------- feet ---------------- */

  /** The foot's frame flat on the ground: forward along its yaw, up along the ground normal. */
  function flatFrame(out, yaw, nrm) {
    c3.set(Math.sin(yaw), 0, Math.cos(yaw));
    perp(c3, nrm, heading);
    return basisQ(out, AY, AZ, nrm, c3);
  }

  /** Ankle and orientation of a planted foot, rolled by rho about the heel (rho < 0) or the ball (rho > 0). */
  function poseStance(f, Ks) {
    ankleAt(f, f.rho, Ks, f.ankle);
    f.q.copy(q).multiply(q2.setFromAxisAngle(AX, f.rho));
  }

  /** Where a planted foot's ankle would be at roll rho (leaves its flat frame in q). */
  function ankleAt(f, rho, Ks, out) {
    flatFrame(q, f.yaw, f.nrm);
    // Rocking on the heel, or rolling over the toe joint (toes flat) and, the toes fully bent, over their tips.
    const r1 = Math.min(rho, TOE_MAX);
    const pz = (rho < 0 ? HEEL_Z : BALL_Z) * Ks;
    const py = (rho < 0 ? 0 : BALL_Y) * Ks;
    // Ankle relative to the pivot, rotated about the foot's lateral axis.
    let cr = Math.cos(r1);
    let sr = Math.sin(r1);
    const ay = ANKLE_H * Ks - py;
    const az = -pz;
    let y = ay * cr - az * sr + py;
    let z = ay * sr + az * cr + pz;
    if (rho > TOE_MAX) {
      const r2 = rho - TOE_MAX;
      const tz = TIP_Z * Ks;
      cr = Math.cos(r2);
      sr = Math.sin(r2);
      const dz = z - tz;
      z = y * sr + dz * cr + tz;
      y = y * cr - dz * sr;
    }
    return out.set(0, y, z).applyQuaternion(q).add(f.pos);
  }

  /** The ankle (world) of a foot planted at pos/yaw/nrm and pitched to rho on its heel: how a swing ends. */
  function heelStrikeAnkle(out, pos, yaw, nrm, rho, Ks) {
    flatFrame(q3, yaw, nrm);
    const pz = HEEL_Z * Ks;
    const cr = Math.cos(rho);
    const sr = Math.sin(rho);
    const ay = ANKLE_H * Ks;
    const az = -pz;
    return out.set(0, ay * cr - az * sr, ay * sr + az * cr + pz).applyQuaternion(q3).add(pos);
  }

  function plantAll(Ks, yaw, base) {
    st.feet = st.feet || { L: footState(), R: footState() };
    for (const n of SIDES) {
      const f = st.feet[n];
      const s = n === 'L' ? 1 : -1;
      f.pos.copy(base).addScaledVector(leftV, s * HIP_W * W_STAND * Ks);
      f.pos.y = groundAt(f.pos.x, f.pos.z);
      groundN(f.nrm);
      f.yaw = yaw + s * TOE_OUT;
      f.rho = f.rock = f.toe = 0;
      f.swing = null;
      f.blendT = -9;
      poseStance(f, Ks);
    }
    st.phase = TO.L;
    st.holding = true;
  }

  /**
   * Gait timing for a speed (leg lengths/s): human cadence rises with the
   * square root of speed (a constant walk ratio), the swing staying ~0.4-0.5 s
   * while the double support stretches out as he slows.
   */
  function timing(vr) {
    // (Slowly, fewer and shorter steps, down to about 63 a minute; adjusting his feet on the spot,
    // quick small steps.)
    const cad = clamp(Math.max(1.56 * Math.sqrt(Math.max(vr, 0)), 1.5 - 0.45 * smooth(0.08, 0.25, vr)), 1.05, 2.2); // steps/s
    const sw = 0.4 + 0.08 * smooth(0, 0.6, vr) - 0.07 * smooth(0.8, 1.7, vr);
    const ds = Math.max(0.07, 1 / cad - sw);
    return { sw, ds, stance: sw + 2 * ds };
  }
  let T = timing(0);

  /**
   * The stride clock's phase as a share of the cycle's time. The clock runs at
   * the swing's pace in single support and the double support's in double
   * support, so its rate jumps four times a stride; everything that sways with
   * the stride (pelvis, trunk, arms) runs on this even phase instead, which has
   * the same heel strikes (0 and 0.5) and moves at one steady rate.
   */
  function bodyPhase(ph) {
    const cyc = 2 * (T.sw + T.ds);
    const half = ph >= 0.5 ? 0.5 : 0;
    const p = ph - half;
    return half + (p < DS ? (p / DS) * T.ds : T.ds + ((p - DS) / SS) * T.sw) / cyc;
  }

  /**
   * The stance knee's bend through stance (sigma 0..1, heel strike to toe off):
   * a few degrees at heel strike, flexing ~15 degrees as it takes the weight,
   * nearly straight by mid-stance; pre-swing (when the other foot is down) it
   * folds toward the swing's bend.
   */
  function kneeFlex(sigma, amp, pre) {
    // (Giving from the moment the heel strikes, as a knee taking a heavy body's weight does.)
    const x = clamp(sigma / LOAD_PEAK, 0, 1);
    const load = (1 - (1 - x) * (1 - x)) * (1 - smooth(LOAD_PEAK, 0.62, sigma));
    return 0.087 + LOAD_FLEX * amp * load + 0.6 * pre * smooth(0.82, 1, sigma);
  }
  /** Hip to ankle for a knee bend (mesh units). */
  const legSpan = (flex) => Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * Math.cos(flex));

  /**
   * Where foot n should land, tRem seconds from now: half a step ahead of the hip joints (so at
   * each heel strike the leading ankle is as far ahead of the hips as the trailing one is behind,
   * as in a real stride), toe out, not across the other foot.
   */
  function footTarget(n, tRem, Ks, ctx, out) {
    const s = n === 'L' ? 1 : -1;
    const lam = LEG * Ks;
    const striding = smooth(0.02 * lam, 0.1 * lam, ctx.speed); // (a stride's lead comes in with speed, never all at once)
    const ahead = tRem + striding * 0.5 * (T.sw + T.ds);
    // The body ahead by then (decelerating: not past where it will stop).
    let tA = ahead;
    const along = ctx.acc.dot(v) / Math.max(1e-3, ctx.speed);
    if (along < -1e-3) tA = Math.min(ahead, ctx.speed / -along);
    out.copy(pxz).addScaledVector(v, tA).addScaledVector(ctx.acc, 0.5 * tA * tA * 0.5);
    // From the hip joints (ahead of the pelvis), and the heel strike's toes-up pitch draws the
    // ankle back: the ground point lands that much further on.
    out.addScaledVector(heading, (HIP_FWD + HS_BACK * clamp(ctx.walk, 0, 1)) * Ks);
    // On a slope the stance moves up the hill: uphill he plants high ahead and pushes up over the
    // foot, downhill he lands under himself and leaves the foot behind, as on stairs (the shift
    // that asks the same of the leg at heel strike and at toe off).
    if (ctx.speed > 1e-3) {
      const g = ctx.grade;
      const shift = ctx.walk * 0.85 * (LEG - ANKLE_H) * Ks * g / (1 + g * g);
      out.x += (v.x / ctx.across) * shift;
      out.z += (v.z / ctx.across) * shift;
    }
    const yawL = ctx.yaw + clamp(st.yawRate * tRem, -0.6, 0.6);
    const lx = Math.cos(yawL);
    const lz = -Math.sin(yawL);
    const width = (W_STAND + (W_WALK - W_STAND) * ctx.walk + 1.0 * ctx.wide) * HIP_W * Ks;
    out.x += lx * s * width;
    out.z += lz * s * width;
    // Braced to fire: the firing side's foot back, the other forward and a little wider.
    if (ctx.brace) {
      const fwd = s * ctx.brace * 0.16 * lam;
      out.x += Math.sin(yawL) * fwd + lx * s * Math.abs(ctx.brace) * 0.05 * lam;
      out.z += Math.cos(yawL) * fwd + lz * s * Math.abs(ctx.brace) * 0.05 * lam;
    }
    // Not across the line of the other foot, and within a stride of it.
    const o = st.feet[n === 'L' ? 'R' : 'L'].pos;
    const lat = (out.x - o.x) * lx + (out.z - o.z) * lz;
    const minLat = 0.55 * HIP_W * Ks;
    if (s * lat < minLat) {
      out.x += lx * (s * minLat - lat);
      out.z += lz * (s * minLat - lat);
    }
    const dx = out.x - o.x;
    const dz = out.z - o.z;
    const dl = Math.hypot(dx, dz);
    const maxStep = 0.95 * lam;
    if (dl > maxStep) {
      out.x = o.x + (dx * maxStep) / dl;
      out.z = o.z + (dz * maxStep) / dl;
    }
    out.y = groundAt(out.x, out.z);
    // The foot turns with the body, at most ~45 degrees from the other per step (more takes pivot steps).
    const oy = st.feet[n === 'L' ? 'R' : 'L'].yaw;
    return oy + clamp(wrapA(yawL + s * TOE_OUT - oy), -0.8, 0.8);
  }

  /**
   * How much quicker the stride must run (>= 1) for the trailing planted foot to leave the ground
   * before the body is HURRY_REACH past it: setting off briskly, the body outruns a stride timed
   * for the speed it had, and the steps come quicker rather than the legs folding under him.
   * @param {number} Ks mesh scale
   * @param {number} across his speed over the ground
   */
  function hurry(Ks, across) {
    if (!st.grounded || st.holding || across < 1e-3) return 1;
    const p = st.phase;
    const m = p >= TO.R && p < TO.L ? 'L' : 'R'; // the foot leaving next
    const f = st.feet[m];
    if (f.swing) return 1;
    const behind = -((f.pos.x - pxz.x) * heading.x + (f.pos.z - pxz.z) * heading.z);
    // Until its toe off: what is left of the other foot's swing, then the double support.
    const single = m === 'R' ? (p >= TO.L ? (1 - p) / SS : 0) : p < HS.R ? (HS.R - p) / SS : 0;
    const double = m === 'R' ? (p >= TO.L ? 1 : (TO.R - p) / DS) : p < HS.R ? 1 : (TO.L - p) / DS;
    const left = (HURRY_REACH * LEG * Ks - behind) / across;
    return clamp((single * T.sw + double * T.ds) / Math.max(left, 0.05), 1, HURRY_MAX);
  }

  /** How sharply he is being turned on the spot (0..1): his way swinging round fast, he hardly moving. */
  const spin = () => Math.max(smooth(0.5, 1.8, Math.abs(st.yawRate)), smooth(0.25, 0.9, st.turnErr || 0)) * (1 - smooth(0.1, 0.4, st.vr || 0));

  /** Does foot n need to step (moving, or out of place: drifted, turned, or the stance changed)? */
  function needs(n, Ks, ctx) {
    if (!st.grounded || JW.t0 >= 0 || JW.push > 0) return false; // (winding up he steps round to face his way, until the dip begins)
    if (ctx.speed > V_GO * LEG * Ks) return true;
    const f = st.feet[n];
    const yawT = footTarget(n, T.sw, Ks, ctx, d3);
    const lam = LEG * Ks;
    const ex = f.pos.x - d3.x;
    const ez2 = f.pos.z - d3.z;
    const ahead = ex * heading.x + ez2 * heading.z;
    const along = ahead > 0 ? Math.max(0, ahead - STAGGER * lam) : -ahead;
    const err = Math.hypot(ex * heading.z - ez2 * heading.x, along) / lam + Math.abs(wrapA(yawT - f.yaw)) * 0.4;
    return err > 0.15;
  }

  function liftOff(n, Ks, ctx) {
    const f = st.feet[n];
    const sw = st.swings[n];
    sw.u = 0;
    // (From where the ankle is drawn, carried on this frame as it was moving: a leg that could not quite
    // reach its planted foot at the last has already let its toes up.)
    sk.limbs[n].ankle.getWorldPosition(sw.a0).addScaledVector(f.vel, ctx.dt);
    sw.yaw0 = f.yaw;
    sw.rho0 = f.rho;
    sw.toe0 = f.toe;
    // The foot's turn on the shin as it leaves the ground (the rig still holds last frame's leg).
    const gL = sk.limbs[n];
    sw.rel0.copy(rootQ).multiply(gL.hip.quaternion).multiply(gL.knee.quaternion).invert().multiply(f.q);
    sw.n0.copy(f.nrm);
    f.swing = sw;
    retarget(n, sw, Ks, ctx);
    // Leaving at the speed the foot already had (no stall at toe off): its share of the swing's travel.
    const dx = sw.a1.x - sw.a0.x;
    const dz = sw.a1.z - sw.a0.z;
    sw.v0 = clamp(((f.vel.x * dx + f.vel.z * dz) / Math.max(1e-3, dx * dx + dz * dz)) * T.sw, 0, 1.2);
    // ... and arriving at a share of his own speed (the leg reaches its longest at the heel strike, not before).
    sw.v1 = clamp((ARRIVE * ctx.speed * T.sw) / Math.max(1e-3, Math.hypot(dx, dz)), 0, 0.3);
    sw.vy0 = Math.max(0, f.vel.y) * T.sw; // (the heel was rising as it pushed off: the lift carries on from there)
    sw.m0 = -1; // (how far above the landing leg's reach he is: taken as the body first feels it)
    sw.tipOff = NaN; // (where its toes leave from: see clearToes)
    const lam = LEG * Ks;
    const step = Math.hypot(sw.tPos.x - f.pos.x, sw.tPos.z - f.pos.z) / lam;
    // Clearance: a few centimetres of toe clearance, more for a long stride or a step up.
    sw.lift = (0.03 + 0.025 * clamp(step / 0.6, 0, 1.3)) * lam + Math.max(0, sw.tPos.y - f.pos.y) * 0.2;
  }

  function retarget(n, sw, Ks, ctx) {
    const f = st.feet[n];
    sw.tYaw = footTarget(n, (1 - sw.u) * T.sw, Ks, ctx, sw.tPos);
    groundN(sw.tNrm);
    const step = Math.hypot(sw.tPos.x - f.pos.x, sw.tPos.z - f.pos.z) / (LEG * Ks);
    sw.tRho = HS_ROLL * clamp(step / 0.55, 0.25, 1) * (1 - clamp(ctx.grade * 1.6, 0, 0.85)); // a short step, or one up a slope, lands nearly flat
    heelStrikeAnkle(sw.a1, sw.tPos, sw.tYaw, sw.tNrm, sw.tRho, Ks);
  }

  /** The swinging foot comes down where it was going, `after` seconds ago (within this frame). */
  function land(n, after = 0) {
    const f = st.feet[n];
    const sw = f.swing;
    if (!sw) return;
    f.pos.copy(sw.tPos);
    f.nrm.copy(sw.tNrm);
    f.yaw = sw.tYaw;
    f.rho = f.rock = sw.tRho;
    f.toe = 0;
    f.landT = st.time - after;
    st.prepFoot = null; // (the first step from standing is down: the stride's own sway takes over)
    f.swing = null;
  }

  /** The swing foot's ankle path: a minimum-jerk glide to the heel strike, lifted clear early in the swing. */
  function poseSwing(f, Ks, ctx, n) {
    const sw = f.swing;
    const u = sw.u;
    if (u < 0.72) retarget(n, sw, Ks, ctx);
    // (Leaving at the speed it had, and still coming forward a little as the heel meets the ground.)
    const s = minJerk(u) + sw.v0 * u * (1 - u) ** 3 * (1 + 3 * u) - sw.v1 * (1 - u) * u ** 3 * (4 - 3 * u);
    f.ankle.lerpVectors(sw.a0, sw.a1, s);
    // (The ground is a plane: clear of it all the way. Highest early in the swing, as the knee folds, and still
    // a little up and coming down as the heel reaches for the ground, as a real heel is.)
    f.ankle.y = sw.a0.y + (sw.a1.y - sw.a0.y) * s + (sw.lift * u ** LIFT_A * (1 - u) ** LIFT_B) / LIFT_NORM + sw.vy0 * u * Math.exp(-u / LIFT_CARRY);
    // Going downhill the body is still high late in the swing: the foot comes down with it rather
    // than reaching for the ground early (an overreaching, locked knee).
    if (v.y < 0) f.ankle.y -= v.y * T.sw * Math.max(0, s - u);
    f.yaw = sw.yaw0 + wrapA(sw.tYaw - sw.yaw0) * s;
    f.rho = sw.rho0 * (1 - smooth(0, 0.5, u)) + sw.tRho * smooth(0.45, 0.92, u);
    f.toe = sw.toe0 * (1 - smooth(0, 0.35, u));
    a3.lerpVectors(sw.n0, sw.tNrm, s).normalize();
    flatFrame(q, f.yaw, a3);
    f.q.copy(q).multiply(q2.setFromAxisAngle(AX, f.rho));
  }

  /** Planted: the heel rocks down after the strike; late in stance the heel rises over the ball, toes flat. */
  function updateStance(n, f, Ks, ctx) {
    const sigma = (f.sigma = frac(st.phase - HS[n] + 1) / (0.5 + DS));
    // (The foot starts down the moment the heel strikes and settles flat: the heel rocker.)
    const rolled = clamp((st.time - f.landT) / Math.max(0.06, T.ds * 0.9), 0, 1);
    const rock = f.rock * (1 - rolled) * (1 - rolled);
    // The heel may peel up through terminal stance, if the foot is behind him and he is striding.
    b3.copy(f.pos).sub(pxz);
    const behind = -(b3.x * heading.x + b3.z * heading.z) / (LEG * Ks);
    f.rhoLo = rock < -1e-3 ? rock : 0;
    // (A real foot: heel off just after mid-stance, ~17 degrees up by the other heel strike, ~50 by toe off.)
    f.rhoHi = rock < -1e-3 ? rock : RISE_MAX * clamp((sigma - 0.5) / 0.5, 0, 1) ** 2.5 * smooth(0.0, 0.18, behind) * clamp(ctx.active * 2, 0, 1);
    // Once the other foot is down he pushes off: the heel rises as a real one does, not only as far as the leg needs.
    f.rho = f.rhoLo < 0 ? f.rhoLo : f.rhoHi * smooth(0.78, 0.92, sigma);
    // Winding up a leap: while the other foot steps round he pivots on the ball of this one (as people
    // turn sharply on the spot); in the dip, both down, the feet only finish the turn on their balls,
    // a little (more would twist them across each other: the rest is the hips' and trunk's).
    if (JW.t0 < 0) f.piv = 0;
    const other = st.feet[n === 'L' ? 'R' : 'L'];
    if (ctx.crouch > 0.3 && (other.swing || JW.t0 >= 0)) {
      const want = ctx.yaw + (n === 'L' ? 1 : -1) * TOE_OUT;
      let dy = clamp(wrapA(want - f.yaw), -PIVOT_W * ctx.dt, PIVOT_W * ctx.dt);
      if (!other.swing) dy = clamp(dy, -PIVOT_CAP - f.piv, PIVOT_CAP - f.piv);
      f.piv += dy;
      if (Math.abs(dy) > 1e-5) {
        flatFrame(q, f.yaw, f.nrm);
        a3.set(0, BALL_Y * Ks, BALL_Z * Ks).applyQuaternion(q).add(f.pos); // the ball, fixed
        b3.copy(f.pos).sub(a3).applyAxisAngle(f.nrm, dy);
        f.pos.copy(a3).add(b3);
        f.yaw += dy;
      }
    }
    f.toe = f.rho > 0 ? Math.min(f.rho, TOE_MAX) : 0;
    poseStance(f, Ks);
  }

  /**
   * Run the stride clock: single supports at the swing's pace, double supports
   * stretching with slowness; at each toe off the foot lifts only if it needs
   * to, otherwise he stands (or the other foot steps first).
   */
  function runClock(dt, Ks, ctx) {
    let left = dt;
    let moved = false;
    for (let guard = 0; guard < 8 && left > 1e-7; guard++) {
      const ph = st.phase;
      // At a toe off: go, let the other foot go first, or stand.
      for (const n of SIDES) {
        if (Math.abs(ph - TO[n]) < 1e-9 && !st.feet[n].swing) {
          const m = n === 'L' ? 'R' : 'L';
          const go = needs(n, Ks, ctx);
          const goM = needs(m, Ks, ctx);
          let first = go ? n : goM ? m : null;
          if (st.holding && ctx.active < 0.3) {
            // Setting off from standing (or starting to move off): the foot his weight is off steps
            // first, and only once he has shifted his weight onto the other (a quarter second, as
            // people do before a first step).
            const setting = ctx.across > APA_V * LEG * Ks && ctx.acc.dot(heading) > 0;
            if (st.prep > 0 && !go && !goM && !setting) {
              st.prep = -1; // (a false start)
              st.prepFoot = null;
            }
            if (st.prep > 0) first = st.prepFoot;
            else if ((go && goM) || (setting && !first)) first = ez.sway.x > 0 ? 'R' : 'L';
            if (first) {
              if (st.prep < 0) {
                st.prep = APA_T * (1 - 0.8 * spin()); // (turning sharply, he steps round at once)
                st.prepFoot = first;
              }
              st.prep -= left;
              if (st.prep > 0) return moved;
            }
          } else if (!go && goM && ctx.active > 0.3) first = n; // (striding on, the feet take turns: a short step rather than the same foot twice)
          st.prep = -1;
          if (!first) st.holding = true;
          else {
            if (first !== n) st.phase = TO[first];
            st.holding = false;
            liftOff(first, Ks, ctx);
          }
          break;
        }
      }
      if (st.holding) {
        st.prep = -1;
        return moved;
      }
      const p = st.phase;
      // Segment: single support (a foot swinging) or double support.
      const single = (p >= TO.R && p < HS.R) || p >= TO.L;
      const rate = single ? SS / T.sw : DS / T.ds;
      let b = 1;
      for (const x of BOUNDS) if (x > p) {
        b = x;
        break;
      }
      const need = (b - p) / rate;
      if (need > left) {
        st.phase = p + rate * left;
        left = 0;
      } else {
        st.phase = b >= 1 ? 0 : b;
        left -= need;
        if (b === HS.R) land('R', left);
        if (b >= 1) land('L', left);
      }
      moved = true;
    }
    return moved;
  }

  /* ---------------- legs ---------------- */

  /**
   * Taking off, the planted feet are not snatched up the frame the knees lock: once a leg in the drive
   * is nearly straight its ankle eases onto the end of its reach about the hip (a critically damped
   * spring, handed the speed the ankle had about the hip), as the toes leave the ground. Until then
   * this only keeps that offset and its speed, to hand over.
   * @param {object} gL the leg's bones
   * @param {object} f the foot (planted until it leaves)
   * @param {number} Ks mesh scale
   * @param {number} dt frame time (s)
   */
  function leaveGround(gL, f, Ks, dt) {
    gL.hip.getWorldPosition(hipW);
    b3.copy(f.ankle).sub(hipW);
    const r = LEAVE_REACH * (L1 + L2) * Ks;
    const drive = (tk.on || JW.push > 0) && !f.swing && dt > 0 && dt <= 0.3;
    if (!drive || (!f.leaving && b3.lengthSq() <= r * r)) {
      f.leaving = false;
      if (dt > 0 && dt <= 0.3) f.offV.copy(b3).sub(f.off).divideScalar(dt);
      else f.offV.set(0, 0, 0);
      f.off.copy(b3);
      return;
    }
    f.leaving = true;
    if (b3.lengthSq() > r * r) b3.setLength(r);
    for (const k of XYZ) {
      _sv.x = f.off[k];
      _sv.v = f.offV[k];
      springStep(_sv, b3[k], LEAVE_W, 1, dt);
      f.off[k] = _sv.x;
      f.offV[k] = _sv.v;
    }
    f.ankle.copy(hipW).add(f.off);
  }

  /**
   * Two-bone IK for one leg toward its ankle target, the knee toward the
   * foot's heading (and the thigh and shin turned with it); soft near full
   * reach so the knee eases straight instead of snapping.
   */
  function solveLeg(g, f, Ks) {
    a3.copy(f.ankle);
    a3.add(f.raise);
    const sinceLand = (st.time - f.blendT) / f.blendTau;
    if (sinceLand < 8) a3.addScaledVector(f.blend, (1 + sinceLand) * Math.exp(-sinceLand)); // (settling onto a landing, from rest)
    a3.applyMatrix4(inv); // into the pelvis bone's frame (mesh units)
    const t = a3.sub(g.hip.position);
    const reach = L1 + L2;
    const soft = 0.99 * reach; // (the knee straightens into its lock smoothly, never snapping into it)
    let d = t.length();
    if (d > soft) d = soft + (reach - soft) * (1 - Math.exp(-(d - soft) / (reach - soft)));
    d = Math.max(d, 0.3 * reach);
    const u = t.normalize();
    // Knee pole: where the foot points (its heading, not its pitch: a foot up on its toes points nearly
    // straight down, and what little is left of its way is the pelvis's tilt), a little outward.
    b3.set(Math.sin(f.yaw), 0, Math.cos(f.yaw));
    if (f.poleW > 0) b3.lerp(f.pole, f.poleW); // (landing, the knees go where the kneel puts them, whatever the feet do)
    b3.applyQuaternion(qInv.copy(rootQ).invert());
    b3.y *= f.poleW; // (a foot's own way is level; a planned one keeps its rise)
    b3.normalize().multiplyScalar(0.75).add(c3.set(g.s * 0.12, 0, 0.25));
    const pole = perp(b3, u, AZ);
    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const d1 = c3.copy(u).multiplyScalar(cosA).addScaledVector(pole, sinA);
    basisQ(g.hip.quaternion, g.restThigh, AZ, d1, pole);
    // Shin: from the knee to the ankle, in the thigh's frame.
    const knee = d1.multiplyScalar(L1);
    const d2 = e3.copy(u).multiplyScalar(d).sub(knee).normalize();
    qInv.copy(g.hip.quaternion).invert();
    d2.applyQuaternion(qInv);
    f3.copy(pole).applyQuaternion(qInv);
    basisQ(g.knee.quaternion, g.restShin, AZ, d2, f3);
    // Foot: its world orientation, in the shin's frame.
    q.copy(rootQ).multiply(g.hip.quaternion).multiply(g.knee.quaternion).invert();
    g.ankle.quaternion.copy(q).multiply(f.q);
    // Swinging, the foot hangs from the shin: from the push-off's pointed toes back to a
    // neutral ankle by mid-swing (the toes clear the ground), then turning to meet the ground
    // heel first as it reaches for it.
    const sw = f.swing;
    if (sw) {
      q2.slerpQuaternions(sw.rel0, SWING_FOOT, smooth(0, 0.42, sw.u));
      g.ankle.quaternion.slerp(q2, 1 - smooth(0.55, 0.95, sw.u));
      clearToes(g, f, Ks, q.invert());
    }
    g.toe.quaternion.setFromAxisAngle(AX, -f.toe);
  }

  const toeUp = new THREE.Vector3();
  const toeFwd = new THREE.Vector3();
  /**
   * Keep a swinging foot's toes off the ground: the ankle turns them up (as the shin's muscles do)
   * as far as they would otherwise come within TOE_CLEAR of it, softly, so there is no corner where
   * it starts. A first step from standing, or the last as he stops, has no push-off to lift them.
   * @param {object} g the leg's bones (the ankle already posed)
   * @param {object} f the swinging foot
   * @param {number} Ks mesh scale
   * @param {THREE.Quaternion} shinQ the shin's world rotation
   */
  function clearToes(g, f, Ks, shinQ) {
    const u = f.swing.u;
    const lam = LEG * Ks;
    const fade = 1 - smooth(0.85, 1, u); // (handing the foot back to the ground's own hold on it)
    if (fade <= 0) return;
    q3.copy(shinQ).multiply(g.ankle.quaternion); // the foot in the world
    toeUp.set(0, 1, 0).applyQuaternion(q3);
    toeFwd.set(0, 0, 1).applyQuaternion(q3);
    // The tips of the toes from the ankle, in the foot, the toes still bent up from the push-off.
    const ct = Math.cos(f.toe);
    const sn = Math.sin(f.toe);
    const y = (BALL_Y - ANKLE_H - BALL_Y * ct + (TIP_Z - BALL_Z) * sn) * Ks;
    const z = (BALL_Z + BALL_Y * sn + (TIP_Z - BALL_Z) * ct) * Ks;
    const A = toeUp.y * y + toeFwd.y * z; // ... how far above it they are
    const tx = f.ankle.x + toeUp.x * y + toeFwd.x * z;
    const tz = f.ankle.z + toeUp.z * y + toeFwd.z * z;
    // (Leaving the ground the tips are on it: the clearance asked for grows from a little below. On
    // uneven ground the plane he reckons with now may pass above where the foot was planted: it
    // is measured from where the tips leave, eased onto that plane through the first of the swing.)
    const w = TOE_CLEAR_SOFT * lam;
    const r = smooth(0, 0.3, u);
    const above = f.ankle.y + A - groundAt(tx, tz);
    const sw = f.swing;
    if (Number.isNaN(sw.tipOff)) sw.tipOff = Math.min(0, above);
    const short = (TOE_CLEAR * lam + 3 * w) * r - 3 * w - (above - sw.tipOff * (1 - smooth(0, 0.4, u)));
    const need = fade * w * Math.log1p(Math.exp(Math.min(short / w, 30)));
    // Turned up by t about the ankle the tips rise to A cos t + B sin t over it. (Taken the whole
    // way round, so a foot pointing straight down still turns its toes up, with no flip.)
    const B = toeUp.y * z - toeFwd.y * y;
    const R = Math.hypot(A, B);
    const phi = Math.atan2(B, A);
    const turn = clamp((phi < 0 ? phi + 2 * Math.PI : phi) - Math.acos(clamp((A + need) / R, -1, 1)), 0, 0.8);
    g.ankle.quaternion.multiply(q3.setFromAxisAngle(AX, -turn));
  }

  /* ---------------- arms ---------------- */

  /**
   * The repulsor pose for one arm, as bone rotations (slerped in by the caller):
   * the arm along `dir` from the shoulder with a soft elbow, rolled so the palm
   * faces down before the wrist bends back: palm to the target, fingers up and
   * back. Recoil climbs the muzzle and draws the hand in.
   */
  const aimQ = { sh: new THREE.Quaternion(), el: new THREE.Quaternion(), wr: new THREE.Quaternion() };
  const qUpper = new THREE.Quaternion();
  const qFore = new THREE.Quaternion();
  const qHand = new THREE.Quaternion();
  const qPar = new THREE.Quaternion();
  const qAim = new THREE.Quaternion();
  const qAim2 = new THREE.Quaternion();
  function aimPose(gA, dir, rec, tipUp = 0, bend = 0) {
    const s = gA.s;
    // Up, as the arm sees it: the world's, square to the arm.
    const upv = d3.copy(UP).addScaledVector(dir, -dir.dot(UP));
    if (upv.lengthSq() < 1e-4) upv.copy(heading);
    upv.normalize();
    // Muzzle climb: the blast throws the hand up about the arm's lateral axis.
    const d = e3.copy(dir).applyAxisAngle(f3.crossVectors(dir, upv).normalize(), RECOIL_CLIMB * rec).normalize();
    perp(upv, d, heading);
    // Elbow: soft, folding as the blast drives the hand back along the beam (out in front of him,
    // never back into the chest).
    const ext = clamp(0.95 - RECOIL_BACK * rec - bend, 0.6, 0.99); // (a soft elbow, never locked)
    const r = ext * (LU + LF);
    const cosA = clamp((LU * LU + r * r - LF * LF) / (2 * LU * r), -1, 1);
    const ang = Math.acos(cosA);
    // Elbow points out and down from the line (its hinge across the palm's plane).
    const nPre = b3.copy(upv).negate(); // the palm before the wrist bends: facing down
    const elbowOut = c3.crossVectors(d, nPre).multiplyScalar(s); // lateral, away from the body
    elbowOut.addScaledVector(nPre, 0.6).normalize();
    perp(elbowOut, d, nPre);
    const d1 = a3.copy(d).applyAxisAngle(f3.crossVectors(d, elbowOut).normalize(), ang);
    // Upper arm.
    gA.clav.getWorldQuaternion(qPar);
    basisQ(qUpper, gA.restUpper, gA.palmN, d1, nPre);
    aimQ.sh.copy(qPar).invert().multiply(qUpper);
    // Forearm: from the elbow to the wrist on the line.
    const elbow = a3.multiplyScalar(LU);
    const d2 = f3.copy(d).multiplyScalar(r).sub(elbow).normalize();
    basisQ(qFore, gA.restFore, gA.palmN, d2, nPre);
    aimQ.el.copy(qUpper).invert().multiply(qFore);
    // Hand: palm toward the target, tipped up a little; fingers up and back; the blast bends it back further.
    const tip = 0.3 + tipUp + RECOIL_FLICK * rec;
    a3.copy(d).addScaledVector(upv, tip).normalize(); // palm normal
    b3.copy(upv).addScaledVector(d, -tip).normalize(); // fingers
    basisQ(qHand, gA.palmN, gA.fingers, a3, b3);
    aimQ.wr.copy(qFore).invert().multiply(qHand);
  }

  /**
   * The fist on the ground (bone rotations into fistQ, slerped in by the caller): the arm from the
   * shoulder to the wrist W, the elbow back and out, the hand straight on the forearm with its
   * knuckles down and its palm toward him.
   * @param {object} gA the arm's bones (the shoulder girdle already posed)
   * @param {THREE.Vector3} W the wrist (world)
   * @param {number} Ks mesh scale
   */
  const fistQ = { sh: new THREE.Quaternion(), el: new THREE.Quaternion(), wr: new THREE.Quaternion() };
  function fistPose(gA, W, Ks) {
    gA.sh.getWorldPosition(f3);
    const d = e3.copy(W).sub(f3);
    const dist = d.length() || 1;
    d.divideScalar(dist);
    const r = clamp(dist / Ks, 0.35 * (LU + LF), 0.995 * (LU + LF));
    const ang = Math.acos(clamp((LU * LU + r * r - LF * LF) / (2 * LU * r), -1, 1));
    // The elbow back (along his heading, reversed) and out to his side; the palm faces back too.
    const elbowOut = c3.copy(heading).multiplyScalar(-0.75).addScaledVector(leftV, 0.65 * gA.s);
    perp(elbowOut, d, leftV);
    const palm = d3.copy(heading).negate();
    const d1 = a3.copy(d).applyAxisAngle(b3.crossVectors(d, elbowOut).normalize(), ang);
    perp(palm, d1, elbowOut);
    gA.clav.getWorldQuaternion(qPar);
    basisQ(qUpper, gA.restUpper, gA.palmN, d1, palm);
    fistQ.sh.copy(qPar).invert().multiply(qUpper);
    const d2 = b3.copy(d).multiplyScalar(r).addScaledVector(d1, -LU).normalize();
    perp(palm, d2, elbowOut);
    basisQ(qFore, gA.restFore, gA.palmN, d2, palm);
    fistQ.el.copy(qUpper).invert().multiply(qFore);
    basisQ(qHand, gA.palmN, gA.fingers, palm, d2);
    fistQ.wr.copy(qFore).invert().multiply(qHand);
  }

  /**
   * A hanging, swinging arm as bone rotations (into armQ): the upper arm down from the shoulder,
   * swung forward by theta and out by alpha; the elbow folding by phi about its own hinge (the
   * forearm coming forward and a touch in); the forearm turned so the palm faces the thigh, pron
   * further toward the back; the wrist eased by wrist. Down is mostly the world's (arms hang),
   * forward and out the chest's.
   */
  const armQ = { sh: new THREE.Quaternion(), el: new THREE.Quaternion(), wr: new THREE.Quaternion() };
  const _av = Array.from({ length: 8 }, () => new THREE.Vector3());
  const qChest = new THREE.Quaternion();
  function armPose(gA, theta, alpha, phi, pron, wrist) {
    const s = gA.s;
    const [ax, az, dn, u, fl, fa, pm, fg] = _av;
    sk.chest.getWorldQuaternion(qChest);
    ax.set(s, 0, 0).applyQuaternion(qChest); // out, his side
    az.set(0, 0, 1).applyQuaternion(qChest);
    // (Hanging by gravity only while he is upright: tipped into flight, they keep to the chest.)
    dn.set(0, -1, 0).applyQuaternion(qChest);
    dn.lerp(DOWN, ARM_HANG * smooth(0.5, 0.95, -dn.y)).normalize(); // (eased off as he bends over: no swing of the arms as he folds and rises)
    perp(az, dn, heading);
    // Upper arm, and the way its elbow folds: forward, a little toward the body.
    u.copy(dn).multiplyScalar(Math.cos(alpha) * Math.cos(theta)).addScaledVector(az, Math.cos(alpha) * Math.sin(theta)).addScaledVector(ax, Math.sin(alpha)).normalize();
    perp(fl.copy(az).addScaledVector(ax, -0.15), u, az);
    fa.copy(u).multiplyScalar(Math.cos(phi)).addScaledVector(fl, Math.sin(phi));
    // Palm: along the elbow's hinge (facing in), turned back by pron about the forearm.
    pm.crossVectors(u, fl).multiplyScalar(s);
    perp(pm, fa, ax).applyAxisAngle(fa, s * pron);
    // Hand: bent at the wrist toward the palm.
    fg.copy(fa).multiplyScalar(Math.cos(wrist)).addScaledVector(pm, Math.sin(wrist));
    gA.clav.getWorldQuaternion(qPar);
    basisQ(qUpper, gA.restUpper, gA.restFlex, u, fl);
    armQ.sh.copy(qPar).invert().multiply(qUpper);
    basisQ(qFore, gA.restFore, gA.palmN, fa, pm);
    armQ.el.copy(qUpper).invert().multiply(qFore);
    pm.multiplyScalar(Math.cos(wrist)).addScaledVector(fa, -Math.sin(wrist));
    basisQ(qHand, gA.fingers, gA.palmN, fg, pm);
    armQ.wr.copy(qFore).invert().multiply(qHand);
  }

  /* ---------------- the model, driven by the rig ---------------- */

  const PQ = new Map(); // rig bone -> its orientation in model space (the rig's rest pose is unrotated)
  const fingerCurl = { L: 0.4, R: 0.4 };
  const thumbW = { L: { open: 0, flat: 0 }, R: { open: 0, flat: 0 } }; // the thumb's pose: relaxed, then spread to fire, then flat in flight
  const qT = new THREE.Quaternion();
  const qc = new THREE.Quaternion();
  const XAX = new THREE.Vector3(1, 0, 0);
  const pelvisRest = V(J.pelvis);
  const pv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  /** Map the model's deform bones onto the rig's, with their rest orientations in model space. */
  function rigModel(m) {
    const drv = {};
    const set = (bone, names) => names.forEach((nm) => (drv[nm] = bone));
    set(sk.root, ['DEF-spine', 'DEF-pelvisL', 'DEF-pelvisR']);
    set(sk.spine, ['DEF-spine001', 'DEF-spine002']);
    set(sk.chest, ['DEF-spine003', 'DEF-spine004', 'DEF-breastL', 'DEF-breastR']);
    set(sk.neck, ['DEF-spine005', 'DEF-spine006']);
    for (const n of SIDES) {
      const g = sk.limbs[n];
      set(g.clav, [`DEF-shoulder${n}`]);
      set(g.sh, [`DEF-upper_arm${n}`, `DEF-upper_arm${n}001`]);
      set(g.el, [`DEF-forearm${n}`, `DEF-forearm${n}001`]);
      set(g.hip, [`DEF-thigh${n}`, `DEF-thigh${n}001`]);
      set(g.knee, [`DEF-shin${n}`, `DEF-shin${n}001`]);
      set(g.ankle, [`DEF-foot${n}`]);
      set(g.toe, [`DEF-toe${n}`]);
      // The fingers bend at the knuckles with the rig's knuckle bone; the thumb and palm stay with the hand.
      for (const f of ['index', 'middle', 'ring', 'pinky']) set(g.knuckles, ['01', '02', '03'].map((k) => `DEF-f_${f}${k}${n}`));
    }
    const root = m.bones['DEF-spine'];
    const order = [];
    const byBone = new Map();
    root.traverse((b) => {
      if (!b.isBone) return;
      const parent = b === root ? null : byBone.get(b.parent);
      const restQ = (parent ? parent.restQ.clone() : new THREE.Quaternion()).multiply(b.quaternion);
      const side = b.name.endsWith('L') ? 'L' : 'R';
      const e = { bone: b, parent, restQ, q: new THREE.Quaternion(), drv: drv[b.name] || sk.limbs[side].wr, side };
      // The finger joints past the knuckle curl further on their own (the rig bends only the knuckle).
      e.distal = /^DEF-f_.*0[23][LR]$/.test(b.name);
      const th = /^DEF-thumb0([123])[LR]$/.exec(b.name);
      e.thumb = th ? ['relax', 'open', 'flat'].map((p) => THUMB_Q[side][p][th[1] - 1]) : null;
      byBone.set(b, e);
      order.push(e);
    });
    return { m, order, root, rootRest: root.position.clone() };
  }

  /** The rig's orientation of each bone in model space. */
  function rigQuats() {
    sk.root.traverse((b) => {
      let q4 = PQ.get(b);
      if (!q4) PQ.set(b, (q4 = new THREE.Quaternion()));
      if (b === sk.root) q4.copy(b.quaternion);
      else q4.copy(PQ.get(b.parent)).multiply(b.quaternion);
    });
  }

  /**
   * Pose the model: each deform bone turned in model space as its rig bone has turned from
   * rest, the pelvis carried as the rig's is, the finger joints curling with the knuckle; then,
   * upright in the air, the artist's hover pose blended in.
   */
  function drive(md, hover) {
    rigQuats();
    for (const e of md.order) {
      e.q.copy(PQ.get(e.drv));
      if (e.thumb) {
        const w = thumbW[e.side];
        e.q.multiply(qT.copy(e.thumb[0]).slerp(e.thumb[1], w.open).slerp(e.thumb[2], w.flat));
      }
      e.q.multiply(e.restQ);
      if (e.parent) e.bone.quaternion.copy(e.parent.q).invert().multiply(e.q);
      else e.bone.quaternion.copy(e.q);
      if (e.distal) e.bone.quaternion.multiply(qc.setFromAxisAngle(XAX, 0.8 * fingerCurl[e.side]));
    }
    md.root.position.copy(md.rootRest).add(a3.copy(sk.root.position).sub(pelvisRest));
    if (hover > 1e-3) {
      const pose = POSE['Fly Pose'];
      for (const e of md.order) {
        const vq = pose[e.bone.name];
        if (!vq || e.thumb) continue; // the artist's thumb is the rest one, jutting out
        e.bone.quaternion.slerp(qc.set(vq[0], vq[1], vq[2], vq[3]), 0.9 * hover);
        if (e.bone === md.root) e.bone.position.lerp(a3.set(vq[4], vq[5], vq[6]), 0.9 * hover);
      }
    }
  }

  /** Centre of a palm, just off its face (world): where the repulsor fires from. */
  function palmOf(md, n, out) {
    const b = md.m.bones;
    const [hand, mid, idx, pinky] = pv;
    b[`DEF-hand${n}`].getWorldPosition(hand);
    b[`DEF-f_middle01${n}`].getWorldPosition(mid);
    b[`DEF-f_index01${n}`].getWorldPosition(idx);
    b[`DEF-f_pinky01${n}`].getWorldPosition(pinky);
    idx.sub(pinky); // across the knuckles
    pinky.copy(mid).sub(hand); // along the hand
    const len = pinky.length();
    hand.crossVectors(pinky, idx).normalize().multiplyScalar(n === 'L' ? 1 : -1); // the palm's face
    b[`DEF-palm02${n}`].getWorldPosition(out);
    return out.add(mid).multiplyScalar(0.5).addScaledVector(hand, 0.3 * len);
  }

  /**
   * Carry the body along its path (in place): followed exactly while it moves smoothly, but a
   * kick in its speed (the crawler launching into a leap, or striking the ground) is taken over a
   * few hundredths of a second, as a body's mass takes it, rather than in one frame.
   */
  const carrier = () => ({ last: new THREE.Vector3(), v: [spring(CARRY_W), spring(CARRY_W), spring(CARRY_W)], x: [spring(CARRY_W), spring(CARRY_W), spring(CARRY_W)], set: false });
  const carried = carrier();
  const carriedTk = carrier(); // (the flight path as he takes off, started at the launch's speed)
  function carry(pos, dt, jumped, cs = carried, v0 = null) {
    const fresh = !cs.set || jumped || dt <= 0 || dt > 0.3;
    cs.set = true;
    for (let k = 0; k < 3; k++) {
      const c = pos.getComponent(k);
      const x = cs.x[k];
      const w = cs.v[k];
      if (fresh) {
        x.x = c;
        x.v = w.x = v0 ? v0.getComponent(k) : 0;
        w.v = 0;
      } else pos.setComponent(k, x.track(c, w.to((c - cs.last.getComponent(k)) / dt, dt), dt));
      cs.last.setComponent(k, c);
    }
    return pos;
  }

  /* ---------------- per frame ---------------- */

  /**
   * Place, pose and light him for this frame, and draw his rays.
   * @param {object} spider the spider as drawn (p, b, F, v, taut, air, crouch, jolt, time, legs)
   * @param {number} frameDt real seconds since the last frame
   * @param {THREE.Camera} camera
   * @param {{at:number[], id:number, p:number}[]} targets words his palms are firing at, and how far each ray has reached
   * @param {number} halfH half the drawing buffer's height (px), for sprite sizes
   */
  function update(spider, frameDt, camera, targets = [], halfH = 450) {
    // A jump in time (a seek) lands every spring and replants the feet; otherwise steps are capped.
    const jumped = frameDt > 0.3;
    const dt = clamp(frameDt, 0, 0.1);
    const sdt = jumped ? frameDt : dt;
    st.time += dt;
    v.set(spider.v[0], spider.v[1], spider.v[2]);
    const speed3 = v.length();
    a3.set(spider.F[0], 0, spider.F[2]);
    if (a3.lengthSq() > 1e-6) heading.copy(a3.normalize());
    leftV.set(heading.z, 0, -heading.x); // his left
    const yaw = Math.atan2(heading.x, heading.z);
    if (st.prevYaw !== null && dt > 0 && !jumped) st.yawRate += (wrapA(yaw - st.prevYaw) / dt - st.yawRate) * (1 - Math.exp(-6 * dt));
    if (jumped) st.yawRate = 0;
    st.prevYaw = yaw;
    if (dt > 0 && !jumped) st.acc.lerp(a3.copy(v).sub(st.prevV).divideScalar(dt), 1 - Math.exp(-5 * dt));
    else if (jumped) st.acc.set(0, 0, 0);
    st.acc.y = 0;
    st.prevV.copy(v);
    const fly = ez.fly.to(spider.taut || 0, sdt);
    const air = ez.air.to(spider.air || 0, sdt);
    const crouch = clamp(ez.crouch.to(spider.crouch && !spider.air ? 1 : 0, sdt), 0, 1.1);
    // Landing: from touchdown the three-point landing has him (the dragline's slack and the jets
    // winding down no longer hold him up).
    // (On its own clock from touchdown, which runs on smoothly between the crawler's steps; a jump in
    // time into a landing takes the crawler's.)
    if (spider.landT >= 0 && (!ld.on || jumped)) ld.t = jumped ? spider.landT : dt; // (touchdown fell within the last frame)
    else if (spider.landT >= 0) ld.t += dt;
    const landT = spider.landT >= 0 ? ld.t : -1;
    landWeights(landT);
    if (spider.air && !st.wasAir && !jumped && !tk.on) beginTakeoff(spider, dt);
    else if (tk.on && (!spider.air || jumped || ld.plan || tk.t > tk.T + 1)) tk.on = false;
    else if (tk.on) tk.t += dt;
    st.wasAir = !!spider.air;
    // (The countdown carries on through the launch from where it last was, so the drive finishes
    // smoothly; a launch with no wind-up, a drop off the dragline, has none.)
    const winding = spider.launchIn >= 0 && !spider.air;
    if (winding) st.tlLast = spider.launchIn;
    else if (!tk.on) st.tlLast = -1;
    const wound = tk.on && st.tlLast >= 0;
    const scale = 1; // true size in flight too: the in-flight shot comes in close instead
    // Winding up, his feet turn to where he will leap from the start, stepping round as the crawler
    // turns (it turns fast): not after it.
    // (Eased in, as a step already under way is turned onto it rather than snatched round.)
    const lv = spider.launchV;
    const going = spider.crouch && !spider.air && Math.hypot(lv[0], lv[2]) > 0.15 * Math.hypot(lv[0], lv[1], lv[2]);
    const yawGo = yaw + wrapA((going ? Math.atan2(lv[0], lv[2]) : yaw) - yaw) * clamp(ez.go.to(going ? 1 : 0, sdt), 0, 1);
    const feetYaw0 = st.feet ? Math.atan2(Math.sin(st.feet.L.yaw) + Math.sin(st.feet.R.yaw), Math.cos(st.feet.L.yaw) + Math.cos(st.feet.R.yaw)) : yaw;
    st.turnErr = spider.crouch && !spider.air ? Math.abs(wrapA(yawGo - feetYaw0)) : 0;
    // (The dip waits for his feet: turned near enough his way, and down, or the last step coming down:
    // he lowers into it, as people do into the step before a jump.)
    const feetSet = !!st.feet && st.turnErr < 0.45 && SIDES.every((n) => !st.feet[n].swing || st.feet[n].swing.u > 0.55);
    jumpWeights(winding ? spider.launchIn : wound ? Math.max(0, st.tlLast - tk.t - dt) : -1, spider.crouchDur || 0, wound ? tk.t : -1, feetSet, spider.launchV, spider.launchRise ?? spider.launchV[1], LEG * K * scale, jumped);
    const g = clamp(Math.max(air, fly), 0, 1) * (1 - LW.on); // off the ground
    // Flight attitude: he leaves upright on his thrusters, pitches into the flight as it gets under way
    // (as soon as he is moving fast: not gliding along upright), holds it, and swings back upright to
    // brake on his boots before he lands.
    const uAir = spider.airU || 0;
    const sp3 = Math.hypot(spider.v[0], spider.v[1], spider.v[2]);
    const att = clamp(ez.att.to((spider.air && spider.taut > 0.05 ? 1 : 0) * smooth(0.1, 0.3, uAir) * (1 - smooth(0.58, 0.85, uAir)) * smooth(0.5 * MPS, 2 * MPS, sp3), sdt), 0, 1);
    const Ks = K * scale;
    const lam = LEG * Ks;

    fitGround(spider, sdt, g);
    pxz.set(spider.p[0], st.gy, spider.p[2]);
    const grade = st.gx * heading.x + st.gz * heading.z; // the slope along his way (rise per unit)
    const across = Math.hypot(v.x, v.z);
    // Speed along the slope (climbing a grade covers more ground per stride than its plan view).
    const speed = across * Math.sqrt(1 + (st.gx * heading.x + st.gz * heading.z) ** 2);
    const speedS = ez.speed.to(speed, sdt);
    const vr = (st.vr = speedS / lam);
    const walk = ez.walk.to((1 - g) * clamp(vr / 1.15, 0, 1.3), sdt);
    T = timing(vr);

    /* ---- targets: each hand keeps to its word, taking the newest on its side ---- */
    const now = spider.time;
    for (const t of targets) {
      a3.set(t.at[0] - spider.p[0], 0, t.at[2] - spider.p[2]);
      // The hand on its side; a word nearly straight ahead goes to the hand already up.
      const az = Math.atan2(a3.dot(leftV), a3.dot(heading));
      t.side = az > 0 ? 'L' : 'R';
      if (Math.abs(az) < 0.4 && st.aim.L.has !== st.aim.R.has) t.side = st.aim.L.has ? 'L' : 'R';
      // Only a word a person could shoot at: from a little across the chest to straight out to the side,
      // not behind, not straight up or down (wider for the word a hand is already on, so it does not flicker).
      const held = st.aim[t.side].id === t.id ? REACH_HOLD : 0;
      const out = t.side === 'L' ? az : -az;
      const elv = Math.atan2(t.at[1] - (st.gy + 1.4 * lam), Math.hypot(a3.x, a3.z));
      if (out < -REACH_IN - held || out > REACH_OUT + held || elv < -REACH_DOWN - held || elv > AIM_UP + REACH_UP + held) t.side = null;
      let rec = st.seen.get(t.id);
      if (!rec) st.seen.set(t.id, (rec = { t: now, p: t.p, back: false }));
      rec.back = t.p < rec.p - 1e-4; // retracting
      rec.p = t.p;
      rec.live = true;
    }
    for (const [id, rec] of st.seen) {
      if (!rec.live) st.seen.delete(id);
      else rec.live = false;
    }
    const tgt = { L: null, R: null };
    for (const n of SIDES) {
      const A = st.aim[n];
      let cur = null;
      let best = null;
      for (const t of targets) {
        if (t.side !== n) continue;
        const rec = st.seen.get(t.id);
        if (t.id === A.id && !rec.back) cur = t;
        if (!best || (!rec.back && (st.seen.get(best.id).back || rec.t > st.seen.get(best.id).t))) best = t;
      }
      // Switch to a newer word, but not more than ~4 times a second (the eye leads, the arm follows).
      const pick = cur && now - A.seen < 0.25 ? cur : best && best.id !== A.id && !st.seen.get(best.id).back ? best : cur || best;
      if (pick && pick.id !== A.id) {
        A.id = pick.id;
        A.seen = now;
      }
      tgt[n] = pick;
      // The arm comes up for a fresh word on its side and stays up between quick shots.
      if (pick && now - st.seen.get(pick.id).t < 1) {
        A.fresh = now;
        A.born = st.seen.get(pick.id).t;
      }
      A.has = now - A.fresh < 0.45;
    }
    // One hand at a time, mostly: walking, only the hand on the newest word's side fires (the other
    // keeps swinging), unless both sides came up together; standing, both may.
    const walkingOn = speedS > 1.5 * V_GO * lam;
    if (st.aim.L.has && st.aim.R.has && walkingOn && Math.abs(st.aim.L.born - st.aim.R.born) > 0.25) {
      const older = st.aim.L.born < st.aim.R.born ? 'L' : 'R';
      st.aim[older].has = false;
    }
    for (const n of SIDES) if (!st.aim[n].has) tgt[n] = null;
    const firingStill = (st.aim.L.has || st.aim.R.has) && !walkingOn;
    const both = firingStill && st.aim.L.has && st.aim.R.has;
    const brace = ez.brace.to(firingStill && !both ? (st.aim.R.has ? 1 : -1) : 0, sdt);
    const wide = ez.wide.to(both ? 1 : 0, sdt); // firing both ways: feet apart, knees bent

    // Feet: (re)planted where they stand when he comes down, or on a jump in time.
    if (!st.feet || jumped || Math.hypot(st.feet.L.pos.x - spider.p[0], st.feet.L.pos.z - spider.p[2]) > 3 * U) plantAll(Ks, yaw, pxz);
    // Coming down: the landing is planned a moment before touchdown, so his legs can reach for their places.
    const tDown = spider.air && spider.airDur > 0 && !ld.on ? Math.max(0, (1 - uAir) * spider.airDur) : Infinity;
    if (ld.plan && !ld.on && landT < 0 && (jumped || tDown > APPROACH_T + 0.1)) ld.plan = false;
    if (!ld.plan && !ld.on && !jumped && tDown < APPROACH_T && landT < 0) planLanding(spider, Ks, lam, tDown, false);
    if (landT >= 0 && (!ld.on || jumped)) beginLanding(spider, Ks, lam, jumped);
    else if (landT < 0 && ld.on) {
      ld.on = false;
      ld.plan = false;
      for (const n of SIDES) {
        st.feet[n].poleW = 0;
        st.feet[n].blendTau = LAND_BLEND;
        st.feet[n].raise.set(0, 0, 0);
      }
    }
    // (The legs' share of the reach for those places, before touchdown.)
    const wA = ld.plan && !ld.on ? 1 - smooth(0.05, APPROACH_T - 0.03, tDown) : 0;
    if (st.grounded && (g > 0.6 || tk.on) && !ld.on) {
      st.grounded = false;
      st.landDipArmed = true;
      // A foot caught mid-step leaves from where it is.
      for (const n of SIDES) {
        const f = st.feet[n];
        if (!f.swing) continue;
        f.pos.copy(f.ankle);
        f.pos.y -= ANKLE_H * Ks;
        f.rho = f.rock = f.toe = 0;
        f.swing = null;
      }
    }
    const ctx = { speed: speedS, across: Math.max(1e-3, across), grade: (st.gx * v.x + st.gz * v.z) / Math.max(1e-3, across), yaw: yawGo, walk: clamp(walk, 0, 1), crouch, acc: st.acc, brace, wide, dt, active: ez.active.x };
    if (!st.grounded && g < 0.35 && !tk.on) {
      st.grounded = true;
      // Down on both feet, under the hips, a little apart and one a touch ahead (as a landing is taken);
      // the legs carry on from where they were reaching, settling onto them over a moment.
      for (const n of SIDES) b3.copy(st.feet[n].ankle).toArray(landFrom[n]);
      plantAll(Ks, yaw, pxz);
      for (const n of SIDES) {
        const f = st.feet[n];
        const s = n === 'L' ? 1 : -1;
        f.pos.addScaledVector(leftV, s * 0.25 * HIP_W * Ks).addScaledVector(heading, s * 0.06 * lam);
        f.pos.y = groundAt(f.pos.x, f.pos.z);
        poseStance(f, Ks);
        f.blend.fromArray(landFrom[n]).sub(f.ankle);
        f.blendT = st.time;
      }
      // Coming down: the knees take the landing.
      if (st.landDipArmed) ez.land.kick(0.9);
      st.landDipArmed = false;
    }

    // Off the ground the legs stretch after the ground as he leaves it, then come in to hang under him
    // (so as the flight pose lets go they reach down, not back to where he took off).
    if (!st.grounded) {
      const k = 1 - Math.exp(-HANG_W * smooth(0.6, 0.95, g) * dt);
      for (const n of SIDES) {
        const f = st.feet[n];
        const s = n === 'L' ? 1 : -1;
        c3.copy(group.position).addScaledVector(leftV, s * HIP_W * Ks);
        c3.y -= J.pelvis[1] * Ks - 0.04 * U;
        f.pos.lerp(c3, k);
        f.nrm.lerp(UP, k).normalize();
        f.yaw += wrapA(yaw + s * TOE_OUT - f.yaw) * k;
      }
    }

    /* ---- stride ---- */
    // (Turning sharply on the spot: quick steps, one straight after the other.)
    const spun = spin();
    const quick = ez.hurry.to(Math.max(hurry(Ks, across), 1 + 0.6 * spun), sdt);
    T.sw /= quick;
    T.ds *= (1 - 0.65 * spun) / quick;
    let stepping = false;
    if (st.grounded && dt > 0 && !ld.on) stepping = runClock(dt, Ks, ctx);
    const active = clamp(ez.active.to(stepping ? 1 : 0, sdt), 0, 1);
    const ph = st.phase;
    const psi = bodyPhase(ph); // (the even phase the body sways on)
    for (const n of SIDES) {
      const f = st.feet[n];
      if (f.swing) {
        f.swing.u = clamp(frac(ph - TO[n] + 1) / SS, 0, 1);
        poseSwing(f, Ks, ctx, n);
      } else if (!ld.on) {
        updateStance(n, f, Ks, ctx);
        if (JW.heel > 0) {
          // The drive: up onto the balls of the feet and the toes as he leaves the ground.
          f.rho = f.rhoHi = Math.max(f.rho, JW.heel);
          f.toe = Math.min(f.rho, TOE_MAX);
          poseStance(f, Ks);
        }
      } else {
        // Kneeling: the rear foot up on its toes, the kneeling knee to the front; rising, the rear foot
        // pushes and then steps in under him, landing flat beside and a little behind the front one.
        if (n === 'R') {
          const u = LW.step;
          f.pos.lerpVectors(ld.fp.R.pos, ld.rStand, minJerk(u));
          f.rho = f.rhoHi = KNEEL_ROLL * (1 - smooth(0.05, 0.8, u));
          f.toe = Math.min(f.rho, TOE_MAX);
          f.pole.copy(ld.h);
        } else f.pole.copy(ld.h).addScaledVector(UP, 1.5).addScaledVector(ld.l, 0.8).normalize(); // (the front knee up and open, beside the chest)
        f.poleW = 1 - LW.rise;
        poseStance(f, Ks);
      }
    }

    /* ---- pelvis: over the stance foot, as high as the stance leg's knee allows ---- */
    const amp = active * clamp(walk, 0, 1.2);
    const shift = ez.shift.to((st.prepFoot ? 0 : 1) * (1 - active) * (1 - clamp(walk * 3, 0, 1)) * (hash(Math.floor(now / 3.7)) - 0.5) * 2 * (1 - crouch), sdt); // idle: weight onto one leg, now and then
    // Setting off: onto the stance foot first, until the stride's own sway takes over.
    const apa = ez.apa.to(st.prepFoot ? (st.prepFoot === 'R' ? 1 : -1) * (st.prep > 0 ? 1 : 1 - active) : 0, sdt);
    const dip = ez.land.to(0, sdt);
    // Over the stance foot (leading the step a little); at rest, the weight shifts.
    const latAmp = (0.034 - 0.012 * clamp(walk, 0, 1)) * lam * active;
    const sway = ez.sway.to(latAmp * Math.sin(2 * Math.PI * (psi - 0.02)) + shift * 0.045 * lam + apa * APA_SHIFT * lam, sdt);
    // The blasts push him back a touch, away from what he fires at: through his legs, so the body gives a
    // beat after the arm (and the knees give with it).
    e3.set(0, 0, 0);
    for (const n of SIDES) {
      const d = st.aim[n].dir;
      const h = Math.hypot(d.x, d.z) || 1;
      e3.x -= (ez.kick[n].x * d.x) / h;
      e3.z -= (ez.kick[n].x * d.z) / h;
    }
    const pushX = ez.pushX.to(e3.x * KICK_PUSH * lam, sdt);
    const pushZ = ez.pushZ.to(e3.z * KICK_PUSH * lam, sdt);

    // Orientation: upright on the ground (crouching, he folds forward); head-first in flight, pitched
    // over his own left-right axis toward where he is going (forward into level flight, on over into a
    // dive). One turn, eased as one: never through a flip, as a head and a chest direction eased
    // separately can be when he dives nearly straight down.
    // (Toward where he is going, eased: the way he moves turns sharply as he lands.)
    // (On the ground there is no way he is flying: upright, so the flight's pitch grows from there.)
    const elev = ez.elev.to(!spider.air ? 0 : speed3 > 0.3 * MPS ? Math.atan2(v.x * heading.x + v.z * heading.z, v.y) : ez.elev.x, sdt);
    const pitch = att * elev;
    bodyQ.setFromAxisAngle(UP, yaw).multiply(q3.setFromAxisAngle(AX, pitch));
    body.quaternion.slerp(bodyQ, jumped ? 1 : 1 - Math.exp(-9 * dt));
    head.set(0, 1, 0).applyQuaternion(body.quaternion);
    X.set(1, 0, 0).applyQuaternion(body.quaternion);

    /* ---- where he looks and turns: to the newest word, else along the way (glancing about when idle) ---- */
    let lookY = 0;
    let lookP = 0.12 * clamp(walk, 0, 1); // walking: eyes a few steps ahead
    let twistTo = 0;
    let nT = 0;
    let newest = null;
    for (const n of SIDES) {
      const t = tgt[n];
      if (!t) continue;
      a3.set(t.at[0] - spider.p[0], 0, t.at[2] - spider.p[2]);
      const az = Math.atan2(a3.dot(leftV), a3.x * heading.x + a3.z * heading.z);
      // The firing arm is comfortable a little off the chest's line, on its own side.
      twistTo += az - (n === 'L' ? 0.45 : -0.45);
      nT++;
      if (!newest || st.seen.get(t.id).t > st.seen.get(newest.id).t) newest = t;
    }
    // Hold the look on the word it is on for LOOK_HOLD before the newest draws it.
    const held = tgt.L && tgt.L.id === st.lookId ? tgt.L : tgt.R && tgt.R.id === st.lookId ? tgt.R : null;
    if (held && now - st.lookT < LOOK_HOLD) newest = held;
    else if (newest && newest.id !== st.lookId) {
      st.lookId = newest.id;
      st.lookT = now;
    }
    if (newest) {
      a3.set(newest.at[0] - spider.p[0], newest.at[1] - (st.gy + 1.6 * lam), newest.at[2] - spider.p[2]);
      lookY = Math.atan2(a3.dot(leftV), a3.x * heading.x + a3.z * heading.z);
      lookP = -Math.atan2(a3.y, Math.hypot(a3.x, a3.z));
    } else if (!st.aim.L.has && !st.aim.R.has) {
      // Idle glances: now and then a look somewhere, held, then back.
      const idle = (1 - clamp(walk * 2, 0, 1)) * (1 - crouch);
      const slot = Math.floor(now / 3.6);
      const on = hash(slot * 3.1) > 0.5 ? 1 : 0;
      lookY += idle * on * (hash(slot) - 0.5) * 1.0;
      lookP += idle * on * (hash(slot + 0.37) - 0.6) * 0.35;
    }
    const twist = ez.twist.to(clamp(nT ? twistTo / nT : 0, -0.75, 0.75) * (1 - g), sdt);
    const lk = st.look;
    const ty = clamp(lookY, -1.25, 1.25) * (1 - g);
    const tp = clamp(lookP, -0.5, 0.45) * (1 - g);
    if (sdt > 0.3) {
      lk.y = lk.y0 = lk.y1 = ty;
      lk.p = lk.p0 = lk.p1 = tp;
      lk.T0 = -9;
    } else {
      // Somewhere new: one head turn from where it is (see LOOK_T); drifts of the same target are followed.
      if (Math.hypot(ty - lk.y1, tp - lk.p1) > LOOK_NEW) {
        lk.y0 = lk.y;
        lk.p0 = lk.p;
        lk.T0 = st.time;
        lk.T = LOOK_T[0] + LOOK_T[1] * Math.hypot(ty - lk.y, tp - lk.p);
      }
      lk.y1 = ty;
      lk.p1 = tp;
      const m = minJerk(lk.T0 < 0 ? 1 : clamp((st.time - lk.T0) / lk.T, 0, 1));
      lk.y = lk.y0 + (lk.y1 - lk.y0) * m;
      lk.p = lk.p0 + (lk.p1 - lk.p0) * m;
    }
    const neckY = ez.lookY.to(lk.y, sdt);
    const neckP = ez.lookP.to(lk.p, sdt);

    /* ---- pelvis bone: stride rotation and list; the hips lag a turn on the spot ---- */
    const rotAmp = (0.045 + 0.045 * clamp(walk, 0, 1.2)) * active;
    const pelvisYaw = -rotAmp * Math.cos(2 * Math.PI * psi);
    const pelvisRoll = (0.075 * active * Math.sin(2 * Math.PI * (psi + 0.08)) - 0.07 * shift) * (1 - g);
    const feetYaw = Math.atan2(Math.sin(st.feet.L.yaw) + Math.sin(st.feet.R.yaw), Math.cos(st.feet.L.yaw) + Math.cos(st.feet.R.yaw));
    const hips = ez.hips.to(clamp(wrapA(feetYaw - yaw) * 0.6, -0.6, 0.6) * (1 - g) + twist * 0.3, sdt);
    const tilt = 0.025 * active * Math.cos(4 * Math.PI * (psi - 0.1));
    sk.root.position.y = pelvisY0;
    sk.root.rotation.set(tilt, (pelvisYaw + hips) * (1 - g), pelvisRoll);
    sk.root.rotation.x += KNEEL_PITCH[0] * LW.torso + CM_PITCH[0] * JW.cm * (1 - JW.unfold); // (landing, the pelvis tipped over the kneel; winding up, over the feet)

    // Height: as high as the legs reach. Over each planted foot that is an arc (the inverted
    // pendulum's vault, highest as he passes over it) with this moment's knee bend (giving as it
    // takes the weight) and the heel as far up as it may be; the two legs' arcs are blended through
    // double support, so the body comes down into each step with no corner where one leg hands it
    // to the other; and the swinging leg must reach the ground where it will land, the body
    // settling onto it no faster than a body does. One smooth fall and rise per step, as deep as the
    // step is long, less what the heel and toe rockers take out of it.
    if (ez.pelvisY.x === 0 || jumped) ez.pelvisY.x = J.pelvis[1] * Ks;
    // Where he is carried over the ground: the crawler's path, except coming in to land, when it is his own
    // way into the kneel (handed back to the crawler's as he rises: it stands on the same spot by then).
    anc.set(spider.p[0], 0, spider.p[2]);
    if (ld.plan) {
      landPath(st.time, d3);
      anc.lerp(d3, 1 - LW.rise);
    }
    const onGround = b3.set(anc.x + pushX, st.gy + ez.pelvisY.x, anc.z + pushZ).addScaledVector(leftV, sway);
    // (Winding up, the hips back; driving off, forward, as far as the flight leaves forward.)
    onGround.addScaledVector(heading, (-CM_BACK * JW.cm * (1 - JW.rise) + DRIVE_FWD * JW.fwd * JW.rise) * lam);
    group.position.copy(onGround);
    group.updateMatrixWorld(true);
    // (Crouching, taking a landing, braced to fire: that much lower than the legs would hold him.)
    const lowerCM = JW.depth * lam * JW.cm * (1 - JW.rise); // (winding up: the dip, out again with the drive)
    const lower = softPos(dip, 0.05) * 0.16 * lam + 0.015 * lam * softAbs(brace, 0.15) + 0.02 * lam * wide + KICK_SINK * lam * clamp(Math.hypot(pushX, pushZ) / (KICK_PUSH * lam), 0, 1.5);
    const blendW = (HANDOVER_IDLE + (HANDOVER - HANDOVER_IDLE) * active) * lam;
    let hCon = Infinity;
    for (const n of SIDES) {
      const f = st.feet[n];
      if (f.swing || !st.grounded) continue;
      // This leg holds him up to where it reaches with this moment's knee bend and the heel as
      // far up as it may be. Trailing, it is unloading: it holds nothing up once the other foot is
      // down, and folds (pre-swing) only as its heel comes up.
      f.flex = kneeFlex(f.sigma, amp, active * clamp(walk * 1.5 + 0.3, 0, 1));
      sk.limbs[n].hip.getWorldPosition(hipW);
      ankleAt(f, f.rhoHi, Ks, c3);
      const dT = legSpan(kneeFlex(f.sigma, amp, 0)) * Ks;
      const dx = hipW.x - c3.x;
      const dz = hipW.z - c3.z;
      const hT = c3.y + Math.sqrt(Math.max(0, dT * dT - dx * dx - dz * dz)) - (hipW.y - group.position.y) - st.gy + 2 * lam * smooth(0.94, 1, f.sigma) * active;
      hCon = hCon === Infinity ? hT : smin(hCon, hT, blendW);
    }
    // The swinging leg reaches for the ground before it lands: the body has to be down to where it
    // can by contact, and comes down to it no faster than a body settling into a step.
    for (const n of SIDES) {
      const sw = st.feet[n].swing;
      if (!sw || !st.grounded) continue;
      sk.limbs[n].hip.getWorldPosition(hipW);
      const dT = legSpan(kneeFlex(0, amp, 0) + 0.06 * (1 - smooth(0.6, 1, sw.u))) * Ks; // (a margin while the list and turn of the pelvis by then are guesses)
      const tRem = (1 - sw.u) * T.sw; // the hip where it will be at contact
      const dx = hipW.x + v.x * tRem - sw.a1.x;
      const dz = hipW.z + v.z * tRem - sw.a1.z;
      const gyThen = st.gy + (st.gx * v.x + st.gz * v.z) * tRem; // the ground under him by then (on a slope he has climbed or come down)
      let hT = sw.a1.y + Math.sqrt(Math.max(0, dT * dT - dx * dx - dz * dz)) - (hipW.y - group.position.y) - gyThen + (SETTLE_V + 0.5 * SETTLE_A * tRem) * tRem * lam;
      // Lifting off above that (a step down, a slope falling away), he is let down to it from where
      // he is, over as much of the swing as a body lowered no faster than LET_DOWN_A needs (min-jerk:
      // its peak acceleration is 5.77 x the drop / the time squared), not taken hold of at once.
      if (sw.m0 < 0) {
        sw.m0 = Math.max(0, ez.pelvisY.x + lower - hT);
        sw.mU = clamp(Math.sqrt((5.77 * sw.m0) / (LET_DOWN_A * lam)) / T.sw, 0.3, LET_DOWN_U);
      }
      hT += sw.m0 * (1 - minJerk(clamp(sw.u / sw.mU, 0, 1)));
      // Reaching out late in the swing, the foot is nearly there before the hip is: it must reach it now, too.
      if (sw.u > 0.5) {
        const f = st.feet[n];
        const ex = hipW.x - f.ankle.x;
        const ez2 = hipW.z - f.ankle.z;
        hT = Math.min(hT, f.ankle.y + Math.sqrt(Math.max(0, dT * dT - ex * ex - ez2 * ez2)) - (hipW.y - group.position.y) - st.gy);
      }
      hCon = hCon === Infinity ? hT : smin(hCon, hT, (HANDOVER_IDLE + (REACH_BLEND + (HANDOVER - REACH_BLEND) * smooth(0.7, 1, sw.u) - HANDOVER_IDLE) * active) * lam);
    }
    // (Off the ground, nothing to reach: the height of his legs straight under him.)
    const hDes = hCon === Infinity ? (ANKLE_H - HIP_UP + legSpan(KNEE_HANG)) * Ks : hCon;
    // (Followed down without lag, so the landing leg finds the body where it reaches; up no faster
    // than legs push a heavy body up: stepping up a slope, the leading leg extends under him rather
    // than him popping up as the trailing one lets go. A jump in the height wanted eases in.)
    const hWant = hDes - lower;
    const rawV = st.hWant === undefined || jumped || dt <= 0 ? 0 : (hWant - st.hWant) / dt;
    const hWantV = ez.hV.to(clamp(rawV, -TRACK_V * lam, Math.max(RISE_V * lam, RISE_SPEED * speedS, 1.6 * lam * JW.push)), sdt);
    st.hWant = hWant;
    // (Winding up, the dip is laid over this: its speed and acceleration are its own, never a catch-up's;
    // driving off, the heels rise faster than a walk's rise is let be, and the height is let follow them.)
    ez.pelvisY.w = hWant < ez.pelvisY.x ? PELVIS_W : PELVIS_W_UP;
    let pelvisH = ez.pelvisY.track(clamp(hWant, ez.pelvisY.x - DROP_GAP * lam, ez.pelvisY.x + (RISE_GAP + 0.1 * JW.push) * lam), hWantV, sdt) - lowerCM;
    if (ld.on) {
      // Landing: as low as puts the right knee on the ground (its thigh reaching down to it from the
      // hip), reached from the height and speed he came down with as fast as a heavy body's legs take
      // it out (never past it: the knee does not go through the ground); a slow breath while he holds
      // it; then up to where his legs hold him.
      sk.limbs.R.hip.getWorldPosition(hipW);
      const hK = kneelAt(hipW, Ks);
      if (Number.isNaN(ld.hK0)) {
        ld.hK0 = hK;
        const x0 = Number.isNaN(ld.h0) ? 0 : ld.h0 - hK;
        // (A cubic from his height and speed at touchdown to rest in the kneel: it goes no lower than
        // the kneel as long as his speed times its time is under three times the drop.)
        ld.T = clamp(LAND_DROP - LAND_DROP_V * Math.abs(ld.v0), 0.12, x0 > 0 && ld.v0 < 0 ? Math.max(0.12, (2.9 * x0) / -ld.v0) : LAND_DROP);
      }
      const x0 = Number.isNaN(ld.h0) ? 0 : ld.h0 - ld.hK0;
      const sD = clamp(landT / ld.T, 0, 1);
      const drop = x0 * (1 - sD) * (1 - sD) * (1 + 2 * sD) + ld.v0 * ld.T * sD * (1 - sD) * (1 - sD);
      const breathe = 0.006 * lam * Math.sin((2 * Math.PI * landT) / 1.3) * smooth(0.3, 0.6, landT);
      const kneel = hK + drop + breathe;
      // (The rear leg comes down with it, see rearRaise: from as far above its place as the pelvis was above
      // the planned kneel at touchdown, the difference made up through the drop.)
      ld.drop = Math.max(0, drop + (hK - ld.kneelH) * (1 - smooth(0, ld.T, landT)));
      const h = kneel + (st.gy + hWant - ld.ground - kneel) * LW.rise;
      pelvisH = ld.ground + h - st.gy;
      // (The height follower is kept in step, so it carries on from here as he walks on.)
      ez.pelvisY.v = dt > 0 && !jumped ? (pelvisH - ld.lastPH) / dt : 0;
      ez.pelvisY.x = pelvisH;
    }
    ld.lastPH = pelvisH;
    onGround.y = st.gy + pelvisH;
    // Only the crawler's path (and his flight off the ground) is carried: the height his legs give
    // him and his sway are smooth already, and filtered again they would overshoot what the planted
    // legs reach.
    // (Landing, the height is the landing's own, which takes up the flight's at touchdown.)
    c3.set(anc.x + (spider.b[0] - spider.p[0]) * g, ld.on ? 0 : (spider.b[1] - onGround.y) * g, anc.z + (spider.b[2] - spider.p[2]) * g);
    e3.copy(c3);
    carry(c3, sdt, jumped);
    if (ld.on) c3.y = 0;
    if (ld.plan) {
      // (His own way into the kneel is smooth already: not filtered again, which would carry him past its end.)
      c3.x = e3.x;
      c3.z = e3.z;
    }
    a3.set((onGround.x - anc.x) * (1 - g), onGround.y, (onGround.z - anc.z) * (1 - g)).add(c3);
    if (tk.on) {
      // Just launched: on the crawler's flight, from where he left it (the gap closing critically).
      const t = tk.t;
      // (For its first frames, its path from its launch speed and curve; then the crawler's as drawn, from
      // where that left off, the step's difference fading.)
      if (t < 0.04) {
        tk.dp.copy(tk.p0).addScaledVector(tk.vL, t).addScaledVector(tk.aL, 0.5 * t * t).sub(b3.fromArray(spider.p));
        tk.dpT = t;
      }
      c3.fromArray(spider.p).addScaledVector(tk.dp, 1 - smooth(tk.dpT, tk.dpT + 0.5, t));
      carry(c3, sdt, jumped, carriedTk, tk.vL); // (as drawn between the crawler's steps its speed jumps a little at each: taken as a body's mass takes it)
      c3.addScaledVector(tk.off, 1 - smooth(0, tk.T, t)).addScaledVector(tk.offV, t * Math.exp(-TAKEOFF_W * t));
      // (What is left of the takeoff's own path when the flight's takes over again is handed over smoothly.)
      tk.gap.copy(c3).sub(a3);
      tk.gapT = jumped ? -9 : st.time;
      a3.copy(c3);
    } else if (st.time - tk.gapT < TK_HAND) a3.addScaledVector(tk.gap, 1 - smooth(tk.gapT, tk.gapT + TK_HAND, st.time));
    group.position.copy(a3);
    group.updateMatrixWorld(true);
    ld.vy = dt > 0 && !jumped ? (group.position.y - ld.lastY) / dt : 0; // (for the drop he lands with)
    ld.lastY = group.position.y;
    if (dt > 0 && !jumped) tk.v.copy(group.position).sub(tk.last).divideScalar(dt);
    else tk.v.set(0, 0, 0);
    tk.last.copy(group.position);

    /* ---- legs: IK onto the planted and swinging feet, the trailing heel peeling up as it must ---- */
    inv.copy(sk.root.matrixWorld).invert();
    sk.root.getWorldQuaternion(rootQ);
    for (const n of SIDES) {
      const gL = sk.limbs[n];
      const f = st.feet[n];
      if (!f.swing && st.grounded && g < 0.999 && !ld.on) {
        // Longer than this moment's knee bend allows: roll up onto the ball (behind) or back onto
        // the heel (ahead). Pre-swing, the knee flexes and the heel comes well up before toe off.
        gL.hip.getWorldPosition(hipW);
        const reachW = legSpan(f.flex) * Ks;
        if (hipW.distanceTo(f.ankle) > reachW) {
          // Which way rolling helps: back onto the heel if the ankle is ahead of the hip, over the ball if behind.
          // (In the drive of a leap only ever further up onto the toes: rocking back to the heel would flick the foot.)
          const ahead = JW.heel <= 0 && (f.ankle.x - hipW.x) * heading.x + (f.ankle.z - hipW.z) * heading.z > 0;
          let lo = f.rho;
          let hi = ahead ? -0.5 : f.sigma > 0.5 || JW.heel > 0 ? TOE_MAX + 0.6 : Math.max(f.rhoHi, 0.05); // a heel up early rather than a foot sliding
          for (let i = 0; i < 12; i++) {
            f.rho = (lo + hi) / 2;
            poseStance(f, Ks);
            if (hipW.distanceTo(f.ankle) > reachW) lo = f.rho;
            else hi = f.rho;
          }
          f.rho = hi;
          f.toe = f.rho > 0 ? Math.min(f.rho, TOE_MAX) : 0;
          poseStance(f, Ks);
        }
        // A planted foot rolls no faster than a foot does (a leg a little short for a moment takes it, rather
        // than the heel flicking up or slapping down); the heel strike's pitch is taken as it lands.
        if (JW.heel <= 0 && dt > 0 && !jumped && st.time - f.landT > 0.5 * dt) {
          const r = clamp(f.rho, f.rhoDrawn - ROLL_RATE * dt, f.rhoDrawn + ROLL_RATE * dt);
          if (r !== f.rho) {
            f.rho = r;
            f.toe = f.rho > 0 ? Math.min(f.rho, TOE_MAX) : 0;
            poseStance(f, Ks);
          }
        }
      }
      f.rhoDrawn = f.rho;
      if (g < 0.999 && !ld.on) leaveGround(gL, f, Ks, dt);
      // (Kneeling: the rear leg comes down folded as it kneels, its knee and toes meeting the ground together as the drop ends.)
      if (ld.on && n === 'R') rearRaise(f.raise, ld.drop).y += 0.06 * lam * Math.sin(Math.PI * smooth(0, 1, LW.step)); // (and lifts clear as it steps in)
      // (Once down from an approach, the legs are on their places: no flight pose left to hand over from.)
      const gl = ld.on && ld.approached ? 0 : g;
      if (gl < 0.999) solveLeg(gL, f, Ks);
      if (gl > 0.001) {
        const bones = [gL.hip, gL.knee, gL.ankle, gL.toe];
        if (gl < 0.999) bones.forEach((b, k) => qLegG[k].copy(b.quaternion));
        // Coming in to land, the front (left) leg reaches forward for the ground and the right
        // folds back, ready to kneel.
        const prep = ld.on ? 1 : spider.air ? smooth(0.8, 0.97, uAir) * (1 - att) : 0; // (held as it hands over to the landing)
        const front = n === 'L' ? prep : 0;
        const rear = n === 'R' ? prep : 0;
        gL.hip.quaternion.setFromEuler(euler.set(0.12 * att - 0.15 * air * (1 - att) - 0.45 * front + 0.2 * rear, 0, -gL.s * 0.03 * att));
        gL.knee.quaternion.setFromEuler(euler.set(0.18 * att + 0.35 * air * (1 - att) + 0.2 * front + 0.6 * rear, 0, 0));
        gL.ankle.quaternion.setFromEuler(euler.set(0.5 * fly + 0.2 * air * (1 - fly) - 0.3 * front, 0, 0));
        gL.toe.quaternion.identity();
        if (wA > 0) {
          // The approach: the legs reach for the places planned for them, the front foot coming
          // straight down onto its spot to meet the ground at touchdown, the rear leg folded as it
          // will kneel, carried down with the body (and along with it, until it nears the ground).
          // The ankle is taken from where the flight pose has it to there, and the foot turned to
          // how it will stand, so the leg reaches rather than swapping one pose for another.
          bones.forEach((b, k) => qLegF[k].copy(b.quaternion));
          const p = ld.fp[n];
          const a = ld.ap[n];
          gL.ankle.getWorldPosition(a.ankle);
          gL.ankle.getWorldQuaternion(a.q);
          b3.copy(p.ankle);
          if (n === 'L') {
            b3.y += ((tDown * tDown) / (tDown + 0.06)) * Math.max(-ld.vy, 0.5 * lam); // (slowing onto the ground as it meets it)
            // (Reaching for it from further off, the knee stays a little soft rather than locking and then folding.)
            gL.hip.getWorldPosition(hipW);
            e3.copy(b3).sub(hipW);
            const r = 0.95 * (L1 + L2) * Ks;
            if (e3.lengthSq() > r * r) b3.copy(hipW).add(e3.setLength(r));
          } else b3.add(rearRaise(e3, Math.max(0, group.position.y - ld.ground - ld.kneelH)));
          a.ankle.lerp(b3, wA);
          a.q.slerp(p.q, wA);
          a.pole.copy(p.pole);
          a.poleW = wA;
          a.raise.set(0, 0, 0);
          a.blendT = -9;
          a.toe = p.toe * wA;
          solveLeg(gL, a, Ks);
          if (wA < 1) bones.forEach((b, k) => b.quaternion.slerp(qLegF[k], 1 - wA));
        }
        // (Handing over between the ground's pose and the air's.)
        if (gl < 0.999) {
          bones.forEach((b, k) => {
            qLegA[k].copy(b.quaternion);
            b.quaternion.copy(qLegG[k]).slerp(qLegA[k], gl);
          });
        }
      }
    }

    for (const n of SIDES) {
      const f = st.feet[n];
      if (dt > 0 && !jumped) f.vel.copy(f.ankle).sub(f.last).divideScalar(dt);
      else f.vel.set(0, 0, 0);
      f.last.copy(f.ankle);
    }

    /* ---- torso and head ---- */
    // Thorax against the pelvis (shoulders counter-rotate), leaning into the walk, up a slope, into a
    // speed-up; chest turned to the words; breathing; the head held level and looking.
    const breath = Math.sin(spider.time * 1.6);
    const cr = clamp(crouch, 0, 1);
    const accel = st.acc.dot(heading) / lam;
    const lean = ez.lean.to((0.045 * clamp(walk, 0, 1.2) + 0.35 * clamp(Math.atan(grade), -0.4, 0.6) * (grade > 0 ? 1 : 0.4) + clamp(accel * 0.06, -0.08, 0.1)) * (1 - g), sdt);
    const kickB = ez.kick.L.x + ez.kick.R.x;
    const reach = ez.ext.to(clamp(Math.max(st.aimHigh.L, st.aimHigh.R), 0, 0.5) * 0.5, sdt); // (leaning back to a high word)
    const kickT = (ez.kick.R.x - ez.kick.L.x) * KICK_TURN; // the firing side's shoulder driven back
    const counter = -1.6 * pelvisYaw * (1 - g);
    const turnUp = -(hips) + twist;
    const fold = JW.cm * (1 - JW.unfold); // (winding up: forward over his feet, up again with the drive)
    // Secondary motion (see SEC_PITCH): off in the air and through the landing's own acting.
    const onFeet = (1 - g) * (1 - att) * (1 - LW.on);
    const yawNow = Math.atan2(heading.x, heading.z);
    const yawRate = st.secYaw === undefined || jumped || dt <= 0 ? 0 : wrapA(yawNow - st.secYaw) / dt;
    st.secYaw = yawNow;
    const vAcc = st.secPV === undefined || jumped || dt <= 0 ? 0 : (ez.pelvisY.v - st.secPV) / dt;
    st.secPV = ez.pelvisY.v;
    const secP = ez.secP.to(clamp(-SEC_PITCH * (st.acc.dot(heading) / G_W), -0.1, 0.1) * onFeet, sdt);
    const secR = ez.secR.to(clamp(SEC_ROLL * (st.acc.dot(leftV) / G_W), -0.08, 0.08) * onFeet, sdt);
    const nod = ez.nod.to(clamp(-SEC_NOD * (vAcc / G_W), -0.1, 0.1) * onFeet, sdt);
    const turnLead = ez.lead.to(clamp(SEC_LEAD * yawRate, -0.35, 0.35) * onFeet, sdt);
    const tl = st.time;
    const lifeY = LIFE * (Math.sin(0.53 * tl + 1.3) + 0.6 * Math.sin(1.27 * tl + 4.1)) * onFeet;
    const lifeP = LIFE * (0.8 * Math.sin(0.71 * tl + 2.2) + 0.45 * Math.sin(1.9 * tl + 0.7)) * onFeet;
    const lifeR = 0.5 * LIFE * Math.sin(0.37 * tl + 5.0) * onFeet;
    sk.spine.rotation.set(0.5 * lean + CM_PITCH[1] * fold + 0.012 * breath - 0.45 * KICK_ROCK * kickB - 0.4 * reach, 0.45 * (counter + turnUp) + kickT * 0.4, -pelvisRoll * 0.55);
    sk.chest.rotation.set(0.5 * lean + CM_PITCH[2] * fold + 0.015 * breath - 0.55 * KICK_ROCK * kickB - 0.6 * reach, 0.55 * (counter + turnUp) + kickT * 0.6, -pelvisRoll * 0.3);
    sk.spine.rotation.x += 0.4 * secP;
    sk.spine.rotation.z += 0.4 * secR;
    sk.chest.rotation.x += 0.6 * secP;
    sk.chest.rotation.y += 0.4 * lifeY + 0.25 * turnLead;
    sk.chest.rotation.z += 0.6 * secR + lifeR;
    if (ld.on) {
      // Landing: folded over the kneel (the pelvis is already), turned and bent toward the fist,
      // breathing hard as he holds it.
      const w = LW.torso;
      sk.spine.rotation.x += KNEEL_PITCH[1] * w + 0.02 * w * Math.sin(spider.time * 4.2);
      sk.spine.rotation.y += 0.5 * KNEEL_TURN * w;
      sk.spine.rotation.z += 0.5 * KNEEL_BEND * w;
      sk.chest.rotation.x += KNEEL_PITCH[2] * w + 0.025 * w * Math.sin(spider.time * 4.2 - 0.4);
      sk.chest.rotation.y += 0.5 * KNEEL_TURN * w;
      sk.chest.rotation.z += 0.5 * KNEEL_BEND * w;
    }
    // Head: cancel what the trunk did under it, then look (85% stabilised, like a real head).
    q.copy(sk.root.quaternion).multiply(sk.spine.quaternion).multiply(sk.chest.quaternion);
    // (Landing, the head goes down with the trunk and bows further, then comes up first as he rises.)
    q.slerp(q2.identity(), 0.15 + 0.6 * LW.head).invert();
    q2.setFromEuler(euler.set(neckP - 0.2 * fold - 0.75 * att + 0.2 * LW.head + nod + lifeP, (neckY + turnLead + lifeY) * (1 - LW.head), 0, 'YXZ'));
    sk.neck.quaternion.copy(q).multiply(q2);
    euler.order = 'XYZ';

    /* ---- arms ---- */
    // Walking: swinging against the legs (left forward with the right foot), elbows flexing more
    // on the forward swing; firing: up onto the word, the other hand ready.
    sk.root.updateMatrixWorld(true);
    for (const n of SIDES) {
      const gA = sk.limbs[n];
      const s = gA.s;
      const A = st.aim[n];
      // The shoulder's swing (+ forward), through a spring (the +0.08 makes up its lag); back, winding up a leap.
      const swingAmp = (0.06 + 0.2 * clamp(walk, 0, 1.2)) * active;
      const ss = n === 'L' ? -1 : 1;
      const armSwing = ez.arm[n].to(ss * swingAmp * Math.cos(2 * Math.PI * (psi + 0.08)) - 0.04 * clamp(walk, 0, 1) + JW.arms, sdt);
      const fwd = softPos(armSwing + 0.08, 0.05);
      const other = n === 'L' ? 'R' : 'L';
      const guard = ez.guard[n].to(st.aim[other].has && !A.has ? 1 - clamp(walk * 1.5, 0, 1) : 0, sdt); // the off hand, while the other fires standing
      const clavY = -s * (0.05 * fwd - 0.04 * guard);
      const clavZ = s * (0.02 * breath + 0.02 * guard) * (1 - att);
      gA.clav.rotation.set(0, clavY, clavZ);
      if (n === 'R') {
        gA.clav.rotation.y -= s * FIST_DROP * LW.fist;
        gA.clav.rotation.z -= s * FIST_DROP * LW.fist;
      }
      gA.clav.updateMatrixWorld(true);
      // The elbow folds more on the forward swing, following the shoulder a beat late and a touch past
      // (its own spring): the forearm's follow-through. The off hand: a little back and out to balance
      // the shot, elbow soft, palm turned in. (Resting on one leg, the arms a little out.)
      const elbow = ez.elbow[n].to(ELBOW_REST + 1.1 * softPos(armSwing + 0.1, 0.05) + 0.25 * guard + 0.3 * fold, sdt);
      armPose(gA, armSwing * (1 - 0.5 * guard) - 0.1 * guard, ARM_OUT + 0.04 * clamp(walk, 0, 1) + 0.2 * guard + 0.06 * softAbs(shift, 0.15) + JW.out, elbow, ARM_PRONATE * (1 - guard) * (1 - JW.out / TAKEOFF_OUT), 0.12);
      gA.sh.quaternion.copy(armQ.sh);
      gA.el.quaternion.copy(armQ.el);
      gA.wr.quaternion.copy(armQ.wr);
      // In flight, arms down at his sides, palms back: the repulsors push him along.
      if (att > 1e-3) {
        gA.sh.quaternion.slerp(q3.setFromEuler(euler.set(0.3, 0, -s * (0.6 + ARM_REST_FIX))), att);
        gA.el.quaternion.slerp(q3.identity(), att);
        gA.wr.quaternion.slerp(q3.setFromEuler(euler.set(0.9, 0, 0)), att);
      }
      // Landing: the right fist driven into the ground, the left arm swept back and out.
      if (ld.on && n === 'R' && LW.fist > 1e-3) {
        ld.wrist.copy(ld.fist).addScaledVector(UP, FIST_H * Ks);
        fistPose(gA, ld.wrist, Ks);
        gA.sh.quaternion.slerp(fistQ.sh, LW.fist);
        gA.el.quaternion.slerp(fistQ.el, LW.fist);
        gA.wr.quaternion.slerp(fistQ.wr, LW.fist);
      }
      if (ld.on && n === 'L' && LW.arm > 1e-3) {
        armPose(gA, -0.55, 0.7, 0.2, 1.0, -0.15);
        gA.sh.quaternion.slerp(armQ.sh, LW.arm);
        gA.el.quaternion.slerp(armQ.el, LW.arm);
        gA.wr.quaternion.slerp(armQ.wr, LW.arm);
      }
      // Aim: on its word, the direction eased (a quick, smooth move between words).
      const lead = ez.aim[n].x > 0.3 ? 1 : smooth(LOOK_LEAD[0], LOOK_LEAD[1], now - A.seen);
      const aimTo = (A.has ? lead : 0) * (1 - g) * (1 - cr) * (1 - LW.on);
      ez.aim[n].w = aimTo < ez.aim[n].x ? AIM_DROP_W : AIM_RAISE_W; // (it comes up deliberately and drops sooner, relaxing)
      const a = clamp(ez.aim[n].to(aimTo, sdt), 0, 1);
      const elA = ez.aimEl[n];
      elA.w = a > elA.x ? RAISE_EL_W[0] : RAISE_EL_W[1];
      const aEl = clamp(elA.to(a, sdt), 0, 1);
      const wrA = ez.aimWr[n];
      wrA.w = aEl > wrA.x ? RAISE_WR_W[0] : RAISE_WR_W[1];
      const aWr = clamp(wrA.to(aEl, sdt), 0, 1);
      aimW[n] = a;
      const rec = ez.recoil[n].to(0, sdt);
      const kb = ez.kick[n].to(0, sdt);
      if (tgt[n]) {
        gA.clav.updateMatrixWorld(true);
        gA.sh.getWorldPosition(b3);
        a3.set(tgt[n].at[0], tgt[n].at[1], tgt[n].at[2]).sub(b3).normalize();
        // Within reach of a shoulder: not across the chest, not far behind.
        const lat = a3.dot(leftV) * s;
        if (lat < -0.15) a3.addScaledVector(leftV, s * (-0.15 - lat));
        const back = a3.dot(heading);
        if (back < -0.05) a3.addScaledVector(heading, -0.05 - back);
        a3.normalize();
        // Not up over his head (that reads as a wave, not a shot): a high word the arm points up to AIM_UP,
        // the trunk leaning back and the palm tipping up for the rest.
        const el = Math.asin(clamp(a3.y, -1, 1));
        st.aimHigh[n] = Math.max(0, el - AIM_UP) * a;
        if (el > AIM_UP) {
          const h = Math.hypot(a3.x, a3.z) || 1e-6;
          a3.set((a3.x / h) * Math.cos(AIM_UP), Math.sin(AIM_UP), (a3.z / h) * Math.cos(AIM_UP));
        }
        aimGoal[n].copy(a3);
        // Onto a new word: one decisive move (see AIM_T), then it holds on the word, following it only as he moves.
        if (A.dirS.lengthSq() < 1e-6 || a < 0.02 || jumped) {
          A.dirS.copy(a3);
          A.dirV.set(0, 0, 0);
          A.mFrom.copy(a3);
          A.mTo.copy(a3);
          A.mT0 = -9;
        } else {
          if (A.mTo.angleTo(a3) > AIM_NEW) {
            A.mFrom.copy(A.dir);
            A.mT0 = now;
            A.mT = Math.min(AIM_T[2], AIM_T[0] + AIM_T[1] * A.dir.angleTo(a3));
          }
          A.mTo.copy(a3);
          const u = A.mT0 < 0 ? 1 : clamp((now - A.mT0) / A.mT, 0, 1);
          qAim2.setFromUnitVectors(_m1.copy(A.mFrom).normalize(), _m2.copy(A.mTo).normalize());
          A.dirS.copy(_m1).applyQuaternion(qAim.identity().slerp(qAim2, minJerk(u)));
          A.dirV.set(0, 0, 0);
        }
        A.dir.copy(A.dirS).normalize();
        aimOn[n] = aEl > AIM_EXT && A.dir.angleTo(aimGoal[n]) < AIM_ON;
      } else {
        aimOn[n] = false;
        // Its word gone, the arm does not stop dead mid-sweep: it carries on a little and comes to rest
        // as it lowers.
        st.aimHigh[n] *= Math.exp(-6 * dt);
        if (A.dirS.lengthSq() > 1e-6 && dt > 0 && !jumped) {
          for (const k of XYZ) {
            _sv.x = A.dirS[k];
            _sv.v = A.dirV[k];
            springStep(_sv, A.dirS[k] + A.dirV[k] / AIM_W, AIM_W, 1, dt);
            A.dirS[k] = _sv.x;
            A.dirV[k] = _sv.v;
          }
          A.dir.copy(A.dirS).normalize();
        }
      }
      if (a > 1e-3) {
        // The shoulder girdle comes forward and up with the arm and is driven back by each blast.
        const raise = clamp(A.dir.y * 1.5 + 0.3, 0, 1);
        gA.clav.rotation.set(0, clavY + a * (-s * (0.12 - 0.18 * kb) - clavY), clavZ + a * (s * (0.1 * raise + 0.04 * kb) - clavZ));
        gA.clav.updateMatrixWorld(true);
        // (Held out, the hand sways a little: slow, irregular, its own on each side.)
        const ph = n === 'L' ? 0 : 2.1;
        _m1.copy(A.dir).applyAxisAngle(UP, AIM_SWAY * (Math.sin(1.7 * st.time + ph) + 0.5 * Math.sin(3.1 * st.time + 2 * ph)));
        _m2.crossVectors(_m1, UP).normalize();
        if (_m2.lengthSq() > 0.5) _m1.applyAxisAngle(_m2, AIM_SWAY * 0.8 * Math.sin(2.3 * st.time + 1.7 * ph));
        aimPose(gA, _m1, rec, 0.5 * st.aimHigh[n], RAISE_FLEX * clamp(2 * (a - aEl), 0, 1));
        gA.sh.quaternion.slerp(aimQ.sh, a);
        gA.el.quaternion.slerp(aimQ.el, aEl);
        gA.wr.quaternion.slerp(aimQ.wr, aWr);
      }
      // Fingers: loosely curled at rest, open and back to fire (flicked further by each blast), straight in flight.
      const curl = (0.42 * (1 - a) - 0.14 * a - 0.18 * rec * a + 0.14 * guard) * (1 - att) + 0.04 * att;
      // (Landing: a fist on the ground; the other hand open behind him.)
      const curled = n === 'R' ? curl + (1 - curl) * LW.fist : curl * (1 - LW.arm);
      gA.knuckles.quaternion.setFromAxisAngle(gA.curlAxis, curled);
      fingerCurl[n] = clamp(curled, 0, 1);
      thumbW[n].open = a * (1 - att);
      thumbW[n].flat = att;
    }

    // The model follows the rig; upright in the air, the artist's hover pose blends in.
    const hover = clamp(ez.hover.to(air * (1 - att), sdt), 0, 1) * (1 - LW.on);
    if (model) drive(model, hover);
    group.updateMatrixWorld(true);

    lights.place(camera, group.position);

    /* ---- effects ---- */
    const L = sk.limbs;
    if (model) {
      palmOf(model, 'L', palms.L);
      palmOf(model, 'R', palms.R);
    } else {
      L.L.palm.getWorldPosition(palms.L);
      L.R.palm.getWorldPosition(palms.R);
    }
    L.L.sole.getWorldPosition(soles[0]);
    L.R.sole.getWorldPosition(soles[1]);
    fxIn.dt = dt;
    fxIn.time = spider.time;
    fxIn.camera = camera;
    fxIn.halfH = halfH;
    fxIn.unit = U / 22.8;
    fxIn.scale = scale;
    const jets = 1 - smooth(0, 0.06, landT); // (cut as his boots meet the ground)
    fxIn.thrust = Math.max(air, fly, 0.8 * smooth(0, 0.35, JW.push)) * jets; // (lit as he pushes off: they lift him)
    fxIn.fly = fly * jets;
    // Each palm fires only at the word its arm is on, and only once it is pointing there.
    for (const t of targets) if (t.side && !(tgt[t.side] === t && aimOn[t.side])) t.side = null;
    fxIn.targets = targets;
    const out = repulsors.update(fxIn);
    // A blast kicks that arm (fast) and pushes through the shoulder and torso (slower); the
    // repulsors light up his own armour.
    for (const n of SIDES) {
      const shots = out.fired[n] || 0;
      if (!shots) continue;
      // (Kicks land on what is left of the last one: a burst drives the hand back a little further,
      // not without limit.)
      ez.recoil[n].kick(Math.max(0, Math.min(1, 0.75 * Math.sqrt(shots)) - 0.5 * Math.max(0, ez.recoil[n].x)));
      ez.kick[n].kick(Math.max(0, Math.min(1, 0.7 * Math.sqrt(shots)) - 0.5 * Math.max(0, ez.kick[n].x)));
    }
    repulsorLight.intensity = 40 * Math.min(2, out.light);
    repulsorLight.position.copy(head).multiplyScalar(0.2 * U);
  }

  return {
    group,
    fx,
    update,
    /** Arc reactor, world space. */
    chest: () => sk.chest.localToWorld(new THREE.Vector3(0, 0.08, 0.3)).toArray(),
    /** Which way his head points, world space. */
    up: () => head.toArray(),
    /** Internal state, for tests and tools. */
    debug: () => st,
  };
}
