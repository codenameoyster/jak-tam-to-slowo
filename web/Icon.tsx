const paths = {
	study: 'M4 5h6a3 3 0 0 1 3 3v13a4 4 0 0 0-4-3H4V5Zm9 3a3 3 0 0 1 3-3h4v13h-3a4 4 0 0 0-4 3',
	words: 'M5 4h14v16H5zM9 9h6M9 13h6',
	add: 'M12 5v14M5 12h14',
	settings: 'M4 7h16M4 17h16M9 4v6M15 14v6',
	exit: 'M9 4H4v16h5M9 12h12m-5-5 5 5-5 5',
	mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-4 6v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6',
	stop: 'M7 7h10v10H7z',
};

export function Icon({ name }: { name: keyof typeof paths }) {
	return <svg width="24" height="24" viewBox="0 0 24 24" fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
