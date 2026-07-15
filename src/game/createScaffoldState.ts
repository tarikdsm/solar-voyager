import { APP_TITLE } from '../core/appInfo.js';
import type { ScaffoldState } from '../sim/scaffoldState.js';

/** Creates the initial application state. */
export function createScaffoldState(): ScaffoldState {
  return { title: APP_TITLE };
}
