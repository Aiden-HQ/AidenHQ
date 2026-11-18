// A steady colour per item (an agent, a module): one of eight curated hues (ui/tokens.css --hue-0…7, each at 3:1 or better on
// the board's surfaces in both themes). Seeded like the monogram avatar (avatar.ts), so an agent's hue matches its face.
import { tone } from "../avatar";

/** The class that sets `--hue` for everything inside it. */
export const hueClass = (name: string) => `hue-${tone(name)}`;
