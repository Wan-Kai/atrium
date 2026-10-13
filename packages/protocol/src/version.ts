/**
 * Version of the Atrium wire protocol spoken between the host and its clients.
 *
 * @remarks
 * Exchanged in the handshake so a client and a host built from different commits refuse
 * to talk instead of misreading each other's messages. Bump it on any incompatible change.
 */
export const PROTOCOL_VERSION = 12;
