import { describe, expect, it } from "vitest";

import {
  buildCorrectedPrompt,
  checkPlanRules,
  checkSceneRules,
  consistencyCheck,
  CORRECTIONS_HEADING,
  criticalIssues,
  extractCounts,
  extractWardrobe,
  pickFrameTimes,
  type QcScene,
  sceneSpecHash,
  stripCorrections,
  visionStatus,
  type VisionReport,
} from "./story-qc";

function scene(overrides: Partial<QcScene> = {}): QcScene {
  return {
    id: "s1",
    number: 1,
    title: "By the water",
    setting: "A sunny meadow",
    action: "Mila walks along the path.",
    narration: "",
    dialogue: [],
    visualPrompt: "Mila walks along a path through a sunny meadow.",
    durationSeconds: 8,
    characters: [{ name: "Mila", visualDescription: "a small fox in a red raincoat and yellow boots", hasReference: true }],
    ...overrides,
  };
}

const categories = (s: QcScene, earlier: QcScene[] = []) => checkSceneRules(s, earlier).map((i) => `${i.severity}:${i.category}`);

describe("checkSceneRules", () => {
  it("passes a consistent scene", () => {
    expect(checkSceneRules(scene())).toEqual([]);
  });

  it("flags 'look behind you' when nobody turns around", () => {
    const s = scene({ dialogue: [{ character: "Mila", line: "Look behind you!" }] });
    expect(categories(s)).toContain("critical:gaze");
    const fixed = scene({ dialogue: s.dialogue, action: "Mila turns around and looks behind her." });
    expect(categories(fixed)).not.toContain("critical:gaze");
  });

  it("flags an object the dialogue points to that isn't shown", () => {
    const s = scene({ dialogue: [{ character: "Mila", line: "Look at the lake, it's so shiny!" }] });
    const issues = checkSceneRules(s);
    expect(issues.find((i) => i.category === "unseen_object")).toMatchObject({ severity: "critical" });
    expect(categories(scene({ dialogue: s.dialogue, setting: "A meadow beside a lake" }))).not.toContain("critical:unseen_object");
  });

  it("flags counts that the prompt doesn't fix, or contradicts", () => {
    const dialogue = [{ character: "Mila", line: "I can see three apples!" }];
    expect(categories(scene({ dialogue }))).toContain("critical:quantity");
    const wrong = checkSceneRules(scene({ dialogue, visualPrompt: "Mila looks at two red apples on a tree." }));
    expect(wrong.find((i) => i.category === "quantity")?.message).toMatch(/shows 2/);
    expect(categories(scene({ dialogue, visualPrompt: "Mila looks at exactly three red apples on a tree." }))).not.toContain("critical:quantity");
  });

  it("flags opposite directions", () => {
    const s = scene({
      dialogue: [{ character: "Mila", line: "The nest is on your left!" }],
      visualPrompt: "Mila points to the right at a nest in a tree.",
    });
    expect(categories(s)).toContain("critical:direction");
  });

  it("flags speakers who aren't in the scene", () => {
    expect(categories(scene({ dialogue: [{ character: "Bo", line: "Hello!" }] }))).toContain("critical:speaker");
    expect(categories(scene({ dialogue: [{ character: "Narrator", line: "Once upon a time." }] }))).not.toContain("critical:speaker");
  });

  it("accepts lines said together by characters in the scene, and flags any missing one", () => {
    const characters = ["Mila", "Zip"].map((name) => ({ name, visualDescription: "a fox", hasReference: true }));
    for (const character of ["Mila & Zip", "Mila and Zip", "Both"]) {
      expect(categories(scene({ characters, dialogue: [{ character, line: "Hello!" }] }))).not.toContain("critical:speaker");
    }
    const issues = checkSceneRules(scene({ characters, dialogue: [{ character: "Mila & Bo", line: "Hello!" }] }));
    expect(issues.filter((i) => i.category === "speaker").map((i) => i.message)).toEqual([expect.stringMatching(/^Bo speaks/)]);
  });

  it("flags wardrobe colours that contradict the character sheet or an earlier scene", () => {
    expect(categories(scene({ visualPrompt: "Mila in a blue raincoat walks through the meadow." }))).toContain("critical:appearance");
    const first = scene({ characters: [{ name: "Mila", visualDescription: "a small fox", hasReference: true }], visualPrompt: "Mila wears a green scarf." });
    const second = scene({ id: "s2", number: 2, characters: first.characters, visualPrompt: "Mila wears a purple scarf." });
    expect(categories(second, [first])).toContain("critical:appearance");
  });

  it("warns when counts change between scenes without a reason", () => {
    const first = scene({ visualPrompt: "Mila holds three apples." });
    const second = scene({ id: "s2", number: 2, visualPrompt: "Mila holds two apples." });
    expect(categories(second, [first])).toContain("warning:prop_continuity");
    expect(categories({ ...second, action: "Mila ate one apple." }, [first])).not.toContain("warning:prop_continuity");
  });

  it("flags dialogue too long for the clip and missing references", () => {
    const long = scene({ durationSeconds: 3, dialogue: [{ character: "Mila", line: "one two three four five six seven eight nine ten eleven twelve thirteen" }] });
    expect(categories(long)).toContain("critical:timing");
    const noRef = scene({ characters: [{ name: "Mila", visualDescription: "a fox", hasReference: false }] });
    expect(categories(noRef)).toContain("warning:reference");
  });

  it("gives issues stable ids", () => {
    const s = scene({ dialogue: [{ character: "Mila", line: "Look behind you!" }] });
    expect(checkSceneRules(s).map((i) => i.id)).toEqual(checkSceneRules(s).map((i) => i.id));
    expect(checkPlanRules([s]).get("s1")).toHaveLength(checkSceneRules(s).length);
  });
});

describe("extractors", () => {
  it("reads counts and wardrobe", () => {
    expect(extractCounts("Count the 4 little ducks and three apples, for two seconds")).toEqual([
      { count: 4, noun: "duck" },
      { count: 3, noun: "apple" },
    ]);
    expect(extractWardrobe("a red raincoat, bright yellow rain boots").get("raincoat")).toBe("red");
    expect(extractWardrobe("a red raincoat, bright yellow rain boots").get("boots")).toBe("yellow");
  });
});

describe("prompt corrections", () => {
  it("appends requirements once and replaces them on the next run", () => {
    const issues = checkSceneRules(scene({ dialogue: [{ character: "Mila", line: "Look at the lake!" }] }));
    const once = buildCorrectedPrompt("Mila in a meadow.", issues)!;
    expect(once).toContain(CORRECTIONS_HEADING);
    expect(once).toContain("Show the lake clearly in frame");
    const twice = buildCorrectedPrompt(once, issues, ["Water sparkles in the sun"])!;
    expect(twice.split(CORRECTIONS_HEADING)).toHaveLength(2);
    expect(stripCorrections(twice)).toBe("Mila in a meadow.");
    expect(buildCorrectedPrompt("x", [])).toBeNull();
  });

  it("ignores the corrections block in the spec hash", () => {
    const base = scene();
    expect(sceneSpecHash({ ...base, visualPrompt: `${base.visualPrompt}\n\n${CORRECTIONS_HEADING}\n- Show the lake.` })).toBe(sceneSpecHash(base));
    expect(sceneSpecHash({ ...base, action: "Something else." })).not.toBe(sceneSpecHash(base));
  });
});

describe("vision and publishing gates", () => {
  const report = (issues: VisionReport["issues"], thumbOk = true): VisionReport => ({
    specHash: "h",
    checkedAt: "",
    model: "m",
    frames: [],
    issues,
    thumbnail: { time: 0.5, ok: thumbOk, note: "Black frame" },
    summary: "",
    promptAdditions: "",
  });
  const critical = { id: "v1", source: "vision" as const, severity: "critical" as const, category: "gaze" as const, message: "Mila looks forward", fix: "", timestamp: 2.5 };

  it("derives the vision status", () => {
    expect(visionStatus(null, "h")).toBe("unchecked");
    expect(visionStatus(report([]), "other")).toBe("stale");
    expect(visionStatus(report([critical]), "h")).toBe("fail");
    expect(visionStatus(report([critical]), "h", ["v1"])).toBe("pass");
    expect(visionStatus(report([], false), "h")).toBe("warn");
  });

  it("fails publishing on unresolved critical issues", () => {
    const check = consistencyCheck({ sceneLabel: "Scene 1", preflightCritical: [], vision: report([critical]), visionStatus: "fail", dismissed: [] });
    expect(check.status).toBe("fail");
    expect(check.details[0]).toContain("0:02.5");
    expect(consistencyCheck({ sceneLabel: "Scene 1", preflightCritical: [], vision: null, visionStatus: "unchecked", dismissed: [] }).status).toBe("warn");
    expect(criticalIssues([critical], ["v1"])).toEqual([]);
  });

  it("picks frame times at shot midpoints and the opening", () => {
    const shots = [
      { number: 1, startSeconds: 0, endSeconds: 4, description: "", characters: [], objects: [] },
      { number: 2, startSeconds: 4, endSeconds: 8, description: "", characters: [], objects: [] },
    ];
    expect(pickFrameTimes(8, shots)).toEqual([0.5, 2, 6]);
    expect(pickFrameTimes(20).length).toBeLessThanOrEqual(8);
  });
});
