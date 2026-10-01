// Wraps conventionalcommits: `refactor` commits trigger a minor bump (upstream: only `feat`).
import createUpstream from "conventional-changelog-conventionalcommits";

export default function createPreset(config) {
  const preset = createUpstream(config);
  const upstreamWhatBump = preset.whatBump;
  preset.whatBump = (commits) => {
    const result = upstreamWhatBump(commits);
    // level: 0 = major, 1 = minor, 2 = patch
    if (result && result.level > 1 && commits.some((c) => c.type === "refactor")) {
      return { ...result, level: 1, reason: `${result.reason} (refactor commits)` };
    }
    return result;
  };
  return preset;
}
