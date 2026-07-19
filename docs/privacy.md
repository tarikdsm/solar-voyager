# Privacy

Solar Voyager has no account system, advertising, analytics, telemetry endpoint, crash-reporting
service, or server-side save. The application does not request a name, email address, location,
camera, microphone, contacts, or payment information.

## Data stored by the application

When used, save and preference controls write only to the current browser profile's `localStorage`:

- `solar-voyager.save.v2` stores the current validated flight;
- `solar-voyager.settings.v2` stores quality, key bindings, and tutorial progress;
- `solar-voyager.settings.v1` may be read once to migrate legacy settings and is not the current
  profile format.

**Export** creates a JSON file locally through the browser. **Import** reads only the file the player
selects and validates it locally. The game does not upload either file. Clearing site data deletes
browser-local saves, so export a copy first if the flight matters.

## Network boundary

The deployed game requests its static HTML, JavaScript, WebAssembly, catalog, model, and texture files
from the same GitHub Pages site. It contains no application code that sends gameplay or settings data
to a project-controlled service.

GitHub Pages, the browser, network operator, or hosting infrastructure may maintain ordinary request
logs outside Solar Voyager's control. Consult GitHub's current privacy documentation for that hosting
layer. Links followed to third-party documentation or source sites are governed by those sites.
