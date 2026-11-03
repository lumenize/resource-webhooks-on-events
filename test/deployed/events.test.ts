// The extension's scenario against the deployed Worker, through the same client the lane uses,
// since some claims, such as what a Worker's fetch can reach, hold only on Cloudflare. It takes §
// *A simple happy path* end to end on A, with two clients keeping copies.
import { describe, it } from 'vitest';
import { eventsScenario } from '../scenarios/events';
import { deployedTier } from './tier';

describe('the extension on the deployed Worker', () => {
  it("takes the proposal's simple happy path: two clients read, subscribe and catch up, one writes, both hear it, and the other catches up with a patch", () => eventsScenario(deployedTier()));
});
