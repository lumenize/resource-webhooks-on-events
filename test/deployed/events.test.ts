// The extension's scenario against the deployed Worker, through the same client the lane uses,
// since some claims, such as what a Worker's fetch can reach, hold only on Cloudflare. It takes §
// *A simple happy path* end to end on A.
import { describe, it } from 'vitest';
import { eventsScenario } from '../scenarios/events';
import { deployedTier } from './tier';

describe('the extension on the deployed Worker', () => {
  it('lists the event, subscribes after the handshake, delivers one event for each write, catches up with a patch, and reports it all redacted', () => eventsScenario(deployedTier()));
});
