import { useId, useLayoutEffect, useRef } from 'react';
import { COMPETITION_TARGET, type Competition } from '../shared/types';
import { updateLadder } from './competition-ladder';

const shirts = ['#2d6a78', '#874b78'];
const sides = [-1, 1];

function Person({ index, initial }: { index: number; initial: string }): React.JSX.Element {
	return <g className="climber" data-person={index}>
		<ellipse className="foot-shadow" cx="0" cy="3" rx="27" ry="5" fill="#000" opacity=".08" />
		{sides.map(side => <g key={side} className="leg" data-side={side} fill="none" stroke="#353f4b" strokeLinecap="round" strokeLinejoin="round">
			<path className="thigh" strokeWidth="12" /><path className="calf" strokeWidth="10" />
			<g className="shoe" stroke="none"><path d="M-6-10Q0-13 6-9L7-1Q0 2-7 0Z" fill="#ebe7dc" /><path d="M-6 1H6" stroke="#91948d" strokeWidth="2" /></g>
		</g>)}
		<path d="M-18-57Q0-53 18-57L17-44 4-40H-4L-17-44Z" fill="#353f4b" />
		{sides.map(side => <g key={side} className="arm" data-side={side} fill="none" stroke="#d7a780" strokeLinecap="round" strokeLinejoin="round">
			<path className="upper-arm" strokeWidth="10" /><path className="forearm" strokeWidth="9" /><path className="sleeve" stroke={shirts[index]} strokeWidth="14" /><circle className="hand" r="5" fill="#d7a780" stroke="none" />
		</g>)}
		<g transform="translate(0,-12)">
			<rect x="-7" y="-87" width="14" height="17" rx="6" fill="#c89570" />
			<path d="M-19-73Q0-82 19-73L21-42Q0-34-21-42Z" fill={shirts[index]} />
			<path d="M-12-71-14-48M12-70 14-46" fill="none" stroke="#fff" opacity=".12" strokeWidth="2" strokeLinecap="round" />
			<path d="M-18-43Q0-38 18-43" stroke="#192b39" opacity=".2" strokeWidth="3" fill="none" />
			<ellipse cx="0" cy="-94" rx="14" ry="17" fill="#d7a780" />
			{index === 0 ? <><path d="M-14-93v-7q1-17 15-15 16 1 13 21l-5 5-2-6-8 3-7-3-3 6Z" fill="#4b3730" /><path d="M-9-106q9-7 18 0" fill="none" stroke="#765747" strokeWidth="2" /></>
				: <><path d="M-14-91q-5-28 14-27 20 0 15 27l-6 8-18-1Z" fill="#42322f" /><ellipse cx="7" cy="-101" rx="9" ry="10" fill="#382825" /><path d="M8-97q17 11 8 30-14-5-10-24" fill="#42322f" /><path d="m4-95 9 3" stroke="#dab584" strokeWidth="3" /></>}
			<text x="0" y="-52" textAnchor="middle" fill="#fff" fontFamily="system-ui,sans-serif" fontSize="12" fontWeight="600">{initial}</text>
		</g>
	</g>;
}

export function CompetitionLadder({ round, compact = false }: { round: Competition | null; compact?: boolean }): React.JSX.Element {
	const id = useId();
	const svg = useRef<SVGSVGElement>(null);
	const target = round?.target ?? COMPETITION_TARGET;
	const bottom = 150 + target * 23;
	const rungY = (score: number) => bottom - score * 23 + 2;
	useLayoutEffect(() => updateLadder(svg.current!, round, true), [round]);
	return <svg ref={svg} className={`competition-ladder${compact ? ' compact' : ''}`} viewBox={`0 0 480 ${bottom + 40}`} aria-hidden="true" focusable="false">
		<defs>
			<linearGradient id={`wood-${id}`} x2="1" y2="0"><stop stopColor="#b1814e" /><stop offset=".23" stopColor="#ddbc89" /><stop offset=".65" stopColor="#cfab76" /><stop offset="1" stopColor="#a47745" /></linearGradient>
			<linearGradient id={`rung-${id}`} x2="0" y2="1"><stop stopColor="#e4c79e" /><stop offset=".35" stopColor="#cca071" /><stop offset="1" stopColor="#a67b4f" /></linearGradient>
			<linearGradient id={`gold-${id}`} x2="1" y2="0"><stop stopColor="#a67320" /><stop offset=".35" stopColor="#edc568" /><stop offset=".66" stopColor="#f6da86" /><stop offset="1" stopColor="#c79832" /></linearGradient>
		</defs>
		<rect x="63" y="116" width="352" height={bottom - 96} rx="16" fill="var(--ladder-wall)" />
		<path d={`M65 ${bottom + 4}h350`} stroke="var(--line)" strokeWidth="2" />
		<ellipse className="ladder-floor" cx="240" cy={bottom + 16} rx="167" ry="13" fill="var(--ladder-floor)" />
		{Array.from({ length: target }, (_, index) => <g key={index} className="rung" data-step={index + 1}>
			<rect x="106" y={rungY(index + 1) + 3} width="268" height="8" rx="4" fill="#5c4026" opacity=".12" />
			<rect className="rung-bar" x="102" y={rungY(index + 1)} width="276" height="8" rx="4" fill={`url(#rung-${id})`} />
			<path d={`M111 ${rungY(index + 1) + 2}h256`} stroke="#f8dfb5" strokeOpacity=".45" />
		</g>)}
		<rect x="90" y="117" width="18" height={bottom - 110} rx="8" fill={`url(#wood-${id})`} /><rect x="372" y="117" width="18" height={bottom - 110} rx="8" fill={`url(#wood-${id})`} />
		<path d={`M96 134q7 ${(bottom - 134) / 2} 1 ${bottom - 134}M379 135q6 ${(bottom - 135) / 2} 0 ${bottom - 135}`} fill="none" stroke="#986e3e" opacity=".3" strokeWidth="1.5" />
		<g className="prize"><g className="trophy">
			<path d="M5 16H-5v13q0 14 16 16M51 16h10v13q0 14-16 16" fill="none" stroke="#bd913f" strokeWidth="6" />
			<path d="M4 8h48v20q0 23-24 23T4 28Z" fill={`url(#gold-${id})`} stroke="#bb8e38" strokeWidth="1.5" />
			<path d="M15 16v13q0 10 5 13" fill="none" stroke="#fff2be" strokeWidth="3" strokeLinecap="round" opacity=".7" />
			<path d="M24 51h8v14H24Z" fill="#ba8c32" /><rect x="12" y="65" width="32" height="8" rx="3" fill={`url(#gold-${id})`} /><rect x="9" y="73" width="38" height="6" rx="2" fill="#6e553b" />
		</g></g>
		{Array.from({ length: target + 1 }, (_, score) => <text key={score} className="tick" x="411" y={rungY(score) + 10} textAnchor="middle">{score}</text>)}
		<Person index={0} initial={round?.participants[0].displayName.slice(0, 1) ?? 'M'} /><Person index={1} initial={round?.participants[1].displayName.slice(0, 1) ?? 'Ż'} />
		<text className="ladder-score" data-score-label="0" x="43" textAnchor="middle" /><text className="ladder-score" data-score-label="1" x="450" textAnchor="middle" />
	</svg>;
}
