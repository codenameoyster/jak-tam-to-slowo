const paths = {
	study: 'M6.5 7h8A2.5 2.5 0 0 1 17 9.5v9a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 4 18.5v-9A2.5 2.5 0 0 1 6.5 7ZM8 3.5h9.5A2.5 2.5 0 0 1 20 6v10',
	words: 'M9.5 6H20M9.5 12H20M9.5 18H20M4.5 6h.01M4.5 12h.01M4.5 18h.01',
	add: 'M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
	correct: 'm5 12.5 4.5 4.5L19 7.5',
	almost: 'M12 6v7.5M12 18h.01',
	again: 'M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4v4h4',
	exit: 'M9 4H4v16h5M9 12h12m-5-5 5 5-5 5',
	mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-4 6v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6',
	stop: 'M7 7h10v10H7z',
};

export function Icon({ name }: { name: keyof typeof paths }) {
	return <svg width="24" height="24" viewBox="0 0 24 24" fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
