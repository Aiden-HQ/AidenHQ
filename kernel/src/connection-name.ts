/**
 * A connection's name, as every layer that lists or routes one accepts it: lowercase letters, digits, `_` and `-`. The module
 * compiler, the launcher's box config and route, and the kernel's backplane route all read this one file, so a name one of them
 * accepts is never dropped or refused by another (a module's `server-manager` is the case that drifted apart).
 */
const NAME_CHARS = "[a-z0-9_-]";
/** A whole connection name. */
export const CONNECTION_NAME = new RegExp(`^${NAME_CHARS}+$`);
/** A connection name as a route's capture group, for the backplane's `ROUTES` (`/c/:connection/mcp`) and the launcher's route. */
export const CONNECTION_SEGMENT = `(${NAME_CHARS}+)`;
/** Whether `name` is a connection name of at most `max` characters (Infinity: no bound). */
export const isConnectionName = (name: unknown, max = Infinity): name is string => typeof name === "string" && name.length <= max && CONNECTION_NAME.test(name);
