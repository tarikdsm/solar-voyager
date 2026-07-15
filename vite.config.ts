import preactPreset from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/solar-voyager/',
  plugins: [preactPreset()],
});
