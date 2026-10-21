import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
const result = await Bun.build({
	entrypoints: ['web/main.tsx', 'web/style.css'],
	outdir: 'dist/assets',
	naming: '[name].[hash].[ext]',
	target: 'browser',
	format: 'esm',
	minify: true,
	env: 'disable',
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
if (!result.success) throw new Error(result.logs.map(log => log.message).join('\n'));
let html = await Bun.file('public/index.html').text();
for (const file of result.outputs) {
	if (file.kind === 'entry-point' || file.loader === 'css') html = html.replace(file.loader === 'css' ? '{{style}}' : '{{script}}', `/assets/${file.path.split('/').pop()}`);
}
await Bun.write('dist/index.html', html);
