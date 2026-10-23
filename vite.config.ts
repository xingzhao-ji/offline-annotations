import { defineConfig } from 'vite';
export default defineConfig({ server: { host: '0.0.0.0', allowedHosts: ['terminal.local'], port: 5176, proxy: { '/api': 'http://127.0.0.1:3044', '/ws': { target: 'ws://127.0.0.1:3044', ws: true } } } });
