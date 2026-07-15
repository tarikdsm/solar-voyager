import { APP_TITLE } from '../core/appInfo';
import type { ScaffoldState } from '../sim/scaffoldState';

/** Creates the initial application state. */
export function createScaffoldState(): ScaffoldState {
  return { title: APP_TITLE };
}
