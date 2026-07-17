import { render } from 'preact';

import { App } from '../../src/ui/App.js';

const root = document.querySelector('#warning-root');
if (!(root instanceof HTMLElement)) throw new Error('Hardware warning root is missing.');

render(<App />, root);
