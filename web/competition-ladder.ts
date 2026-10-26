import type { Competition } from '../shared/types';

interface Point { x: number; y: number }
interface Hand extends Point { side: number }
interface Foot extends Hand { angle: number }
interface Pose extends Point { score: number; hands: Hand[]; feet: Foot[]; prize?: Point }
interface Ladder { target: number; rungY(score: number): number }
interface Climber {
	element: SVGGElement;
	shadow: SVGEllipseElement;
	legs: { thigh: SVGPathElement; calf: SVGPathElement; shoe: SVGGElement }[];
	arms: { upper: SVGPathElement; forearm: SVGPathElement; sleeve: SVGPathElement; hand: SVGCircleElement }[];
	score: number;
	pose: Pose;
	from: Pose;
	landing: Pose;
	to: Pose;
	winning: boolean;
	started: number | null;
}
interface Motion {
	id: string | null;
	target: number;
	climbers: Climber[];
	frame: number;
	glowUntil: number;
}

const motions = new WeakMap<SVGSVGElement, Motion>();
const prizeHome = { x: 212, y: 27 };
const sides = [-1, 1];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function climberPose(score: number, index: number, { target, rungY }: Ladder): Pose {
	const crouch = score > 0 ? Math.max(0, score - target + 2) * 14 : 0;
	const raisedSide = (score + index) % 2 ? -1 : 1;
	return {
		score, x: 0, y: rungY(score) - 2 + crouch,
		hands: sides.map(side => ({ side, x: side * 34, y: rungY(Math.min(target, score + (side === -raisedSide ? 6 : 5))) + 4 })),
		feet: sides.map(side => ({ side, x: side * 17, y: rungY(score + (score > 0 && score < target && side === raisedSide ? 1 : 0)) - 2, angle: 0 })),
	};
}

function winningPose(index: number, lift: number, ladder: Ladder): Pose {
	const pose = climberPose(ladder.target, index, ladder);
	pose.y = ladder.rungY(ladder.target) - 2;
	const inward = index === 0 ? 1 : -1;
	const prize = { x: prizeHome.x - inward * 15 * lift, y: prizeHome.y - 15 * lift };
	pose.hands = pose.hands.map(hand => hand.side === inward
		? { ...hand, x: prize.x + (index === 0 ? -5 : 61) - (index === 0 ? 174 : 306), y: prize.y + 27 }
		: { ...hand, y: pose.y - 132 });
	return { ...pose, prize };
}

function drawClimber(climber: Climber, index: number, prize: SVGGElement) {
	const { element, pose } = climber;
	element.style.transform = `translate(${(index === 0 ? 174 : 306) + pose.x}px,${pose.y}px)`;
	climber.shadow.setAttribute('cy', String(Math.max(...pose.feet.map(foot => foot.y)) - pose.y + 3));
	if (pose.prize) prize.setAttribute('transform', `translate(${pose.prize.x},${pose.prize.y})`);
	pose.feet.forEach((foot, index) => {
		const leg = climber.legs[index];
		const x = foot.x - pose.x, y = foot.y - pose.y;
		const lift = Math.max(0, Math.min(1.7, -y / 23));
		const kneeX = foot.side * (15 + 12 * lift), kneeY = -28 - 23 * lift;
		leg.thigh.setAttribute('d', `M${foot.side * 10} -48L${kneeX} ${kneeY}`);
		leg.calf.setAttribute('d', `M${kneeX} ${kneeY}L${x} ${y - 8}`);
		leg.shoe.setAttribute('transform', `translate(${x},${y}) rotate(${foot.angle})`);
	});
	pose.hands.forEach((hand, index) => {
		const arm = climber.arms[index];
		const x = hand.x - pose.x, y = hand.y - pose.y;
		const reach = Math.max(0, Math.min(1, (-y - 109) / 23));
		const shoulderX = hand.side * 19;
		const elbowX = hand.side * (44 - 9 * reach), elbowY = (-80 + y) / 2 + 7;
		arm.upper.setAttribute('d', `M${shoulderX} -80L${elbowX} ${elbowY}`);
		arm.forearm.setAttribute('d', `M${elbowX} ${elbowY}L${x} ${y}`);
		arm.sleeve.setAttribute('d', `M${shoulderX} -80L${shoulderX + (elbowX - shoulderX) * .5} ${-80 + (elbowY + 80) * .5}`);
		arm.hand.setAttribute('cx', String(x));
		arm.hand.setAttribute('cy', String(y));
	});
}

function stepProgress(progress: number, start: number, end: number) {
	const value = Math.max(0, Math.min(1, (progress - start) / (end - start)));
	return value * value * (3 - 2 * value);
}

function stepPose(from: Pose, to: Pose, progress: number): Pose {
	const rising = to.y < from.y;
	const body = stepProgress(progress, .12, .94);
	const movingFoot = from.feet.find((foot, index) => Math.abs(to.feet[index].y - foot.y) > 23);
	return {
		score: to.score,
		x: mix(from.x, 0, body) - (movingFoot?.side ?? 1) * 2 * Math.sin(Math.PI * progress),
		y: mix(from.y, to.y, body),
		hands: from.hands.map((hand, index) => {
			const target = to.hands[index];
			const t = stepProgress(progress, rising ? 0 : .24, rising ? .74 : 1);
			const swing = hand.y === target.y ? 0 : Math.sin(Math.PI * t);
			return { side: hand.side, x: mix(hand.x, target.x, t) + hand.side * 3 * swing, y: mix(hand.y, target.y, t) };
		}),
		feet: from.feet.map((foot, index) => {
			const target = to.feet[index];
			const trailing = from.score === 0 ? target.y === to.y : to.score === 0 && foot.y < from.y;
			// At the floor, land the first foot before the other foot leaves its support.
			const end = (from.score === 0 || to.score === 0) && !trailing ? .52 : .82;
			const t = stepProgress(progress, trailing ? .52 : .06, trailing ? 1 : end);
			const swing = foot.y === target.y ? 0 : Math.sin(Math.PI * t);
			return { side: foot.side, x: mix(foot.x, target.x, t) + foot.side * 4 * swing, y: mix(foot.y, target.y, t) - 3 * swing, angle: mix(foot.angle, 0, t) + foot.side * 7 * swing };
		}),
	};
}

export function updateLadder(svg: SVGSVGElement, round: Competition | null, animate: boolean): () => void {
	const previous = motions.get(svg);
	if (previous) cancelAnimationFrame(previous.frame);
	const bars = [...svg.querySelectorAll<SVGRectElement>('.rung-bar')];
	const rungs = [bars[0].y.baseVal.value + 23, ...bars.map(bar => bar.y.baseVal.value)];
	const ladder: Ladder = { target: bars.length, rungY: score => rungs[score] };
	const sameRound = previous?.id === (round?.id ?? null) && previous?.target === ladder.target;
	const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
	const prize = svg.querySelector<SVGGElement>('.prize')!;
	if (!sameRound) prize.setAttribute('transform', `translate(${prizeHome.x},${prizeHome.y})`);
	const motion: Motion = { id: round?.id ?? null, target: ladder.target, frame: 0, glowUntil: sameRound ? previous.glowUntil : 0,
		climbers: [...svg.querySelectorAll<SVGGElement>('[data-person]')].map((element, index) => {
			const score = round?.participants[index].score ?? 0;
			const winning = round?.status === 'finished' && round.winnerId === round.participants[index].id;
			const before = sameRound ? previous.climbers[index] : undefined;
			if (animate && before?.score === score && before.winning === winning) return before;
			const landing = climberPose(score, index, ladder);
			const to = winning ? winningPose(index, 1, ladder) : landing;
			const moving = animate && before && Math.abs(before.score - score) === 1 && !reducedMotion();
			const from = moving ? before.pose : to;
			return {
				element, score, pose: from, from, landing, to, winning, started: moving ? performance.now() : null,
				shadow: element.querySelector<SVGEllipseElement>('.foot-shadow')!,
				legs: [...element.querySelectorAll<SVGGElement>('.leg')].map(leg => ({
					thigh: leg.querySelector<SVGPathElement>('.thigh')!, calf: leg.querySelector<SVGPathElement>('.calf')!, shoe: leg.querySelector<SVGGElement>('.shoe')!,
				})),
				arms: [...element.querySelectorAll<SVGGElement>('.arm')].map(arm => ({
					upper: arm.querySelector<SVGPathElement>('.upper-arm')!, forearm: arm.querySelector<SVGPathElement>('.forearm')!,
					sleeve: arm.querySelector<SVGPathElement>('.sleeve')!, hand: arm.querySelector<SVGCircleElement>('.hand')!,
				})),
			};
		}),
	};
	motions.set(svg, motion);
	svg.querySelectorAll<SVGTextElement>('[data-score-label]').forEach((label, index) => {
		const score = motion.climbers[index].score;
		label.textContent = String(score);
		label.setAttribute('y', String(ladder.rungY(score) + 12));
	});
	function frame(now: number) {
		const reduced = reducedMotion();
		motion.climbers.forEach((climber, index) => {
			if (climber.started !== null) {
				const elapsed = now - climber.started;
				if (reduced || elapsed >= (climber.winning ? 1100 : 650)) {
					climber.pose = climber.to;
					climber.started = null;
					if (climber.winning && !reduced) motion.glowUntil = now + 600;
				} else if (elapsed < 650) climber.pose = stepPose(climber.from, climber.landing, elapsed / 650);
				else if (elapsed < 900) {
					const grasp = winningPose(index, 0, ladder), reach = stepProgress((elapsed - 650) / 250, 0, 1);
					climber.pose = { ...climber.landing, y: mix(climber.landing.y, grasp.y, reach), prize: prizeHome,
						hands: climber.landing.hands.map((hand, side) => ({ ...hand, x: mix(hand.x, grasp.hands[side].x, reach), y: mix(hand.y, grasp.hands[side].y, reach) })),
					};
				} else climber.pose = winningPose(index, stepProgress((elapsed - 900) / 200, 0, 1), ladder);
			}
			drawClimber(climber, index, prize);
		});
		if (reduced || now >= motion.glowUntil) motion.glowUntil = 0;
		svg.classList.toggle('celebrate', motion.glowUntil > 0);
		motion.frame = motion.glowUntil || motion.climbers.some(climber => climber.started !== null) ? requestAnimationFrame(frame) : 0;
	}
	frame(performance.now());
	return () => cancelAnimationFrame(motion.frame);
}
