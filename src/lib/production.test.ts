import { describe, expect, it } from "vitest";

import { sampleContent } from "@/test/fixtures";

import {
  buildGenerationPrompt,
  buildVideoPrompt,
  clampDuration,
  clipMusicMood,
  describeDialogue,
  describeReferenceImages,
  AUDIO_QUALITY_RULES,
  DEFAULT_NEGATIVE_PROMPT,
  deriveSceneStatus,
  findPromptConcerns,
  isReadyForAssembly,
  moveInOrder,
  parseDialogueRow,
  parseCharacterForm,
  parseSceneForm,
  parseTimeline,
  IMAGE_QUALITY_RULES,
  VIDEO_QUALITY_RULES,
  scenesFromStory,
  stripNarration,
  summarizeCosts,
  summarizeProgress,
} from "./production";

describe("deriveSceneStatus", () => {
  const base = { visualPrompt: "A duckling", jobs: [], assets: [], selectedAssetApproved: false };

  it("needs a prompt before anything else", () => {
    expect(deriveSceneStatus({ ...base, visualPrompt: "  " })).toBe("draft");
    expect(deriveSceneStatus(base)).toBe("ready");
  });

  it("is generating while any job is active, including manual ones", () => {
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "queued" }] })).toBe("generating");
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "awaiting_manual" }] })).toBe("generating");
  });

  it("asks for review when an asset is pending, even if another job runs", () => {
    expect(
      deriveSceneStatus({ ...base, jobs: [{ status: "in_progress" }], assets: [{ status: "pending_review" }] }),
    ).toBe("review");
  });

  it("reports failure only when the latest job failed", () => {
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "timed_out" }, { status: "completed" }] })).toBe("failed");
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "canceled" }, { status: "failed" }] })).toBe("ready");
  });

  it("is approved only with an approved final asset", () => {
    expect(deriveSceneStatus({ ...base, assets: [{ status: "approved" }] })).toBe("ready");
    expect(deriveSceneStatus({ ...base, assets: [{ status: "approved" }], selectedAssetApproved: true })).toBe("approved");
  });
});

describe("progress", () => {
  it("counts scenes per status and the approved share", () => {
    const progress = summarizeProgress([{ status: "approved" }, { status: "review" }, { status: "approved" }, { status: "draft" }]);
    expect(progress).toMatchObject({ total: 4, approved: 2, percent: 50 });
    expect(progress.counts).toMatchObject({ approved: 2, review: 1, draft: 1, failed: 0 });
  });

  it("handles an empty plan", () => {
    expect(summarizeProgress([])).toMatchObject({ total: 0, percent: 0 });
    expect(isReadyForAssembly([])).toBe(false);
  });

  it("requires every scene to be approved before assembly", () => {
    expect(isReadyForAssembly([{ status: "approved" }, { status: "review" }])).toBe(false);
    expect(isReadyForAssembly([{ status: "approved" }, { status: "approved" }])).toBe(true);
  });
});

describe("summarizeCosts", () => {
  it("sums estimates for chargeable API jobs and counts the rest", () => {
    const costs = summarizeCosts([
      { mode: "api", status: "completed", estimatedCostUsd: "0.0940" },
      { mode: "api", status: "queued", estimatedCostUsd: "0.5" },
      { mode: "api", status: "failed", estimatedCostUsd: "1.00" }, // not charged
      { mode: "api", status: "completed", estimatedCostUsd: null },
      { mode: "manual", status: "completed", estimatedCostUsd: null },
    ]);
    expect(costs.estimatedUsd).toBeCloseTo(0.594);
    expect(costs).toMatchObject({ estimatedJobs: 2, unpricedJobs: 1, manualJobs: 1 });
  });

  it("returns null when no price is known", () => {
    expect(summarizeCosts([{ mode: "api", status: "completed", estimatedCostUsd: null }]).estimatedUsd).toBeNull();
  });
});

describe("buildGenerationPrompt", () => {
  it("appends consistent character descriptions and the style", () => {
    const prompt = buildGenerationPrompt({
      visualPrompt: "Pip splashes in a puddle.",
      characters: [{ name: "Pip", visualDescription: "Small yellow duckling in a blue raincoat." }],
      visualStyle: "Soft 3D animation",
    });
    expect(prompt).toContain("Pip splashes in a puddle.");
    expect(prompt).toContain("Pip: Small yellow duckling in a blue raincoat.");
    expect(prompt).toContain("Visual style: Soft 3D animation.");
    expect(prompt.endsWith(IMAGE_QUALITY_RULES)).toBe(true);
  });

  it("doesn't repeat a style the prompt already has", () => {
    const prompt = buildGenerationPrompt({
      visualPrompt: "Soft 3D animation, pastel colours. A cosy room.",
      characters: [],
      visualStyle: "soft 3d animation, pastel colours",
    });
    expect(prompt).toBe(`Soft 3D animation, pastel colours. A cosy room.\n\n${IMAGE_QUALITY_RULES}`);
  });
});

describe("describeDialogue", () => {
  it("quotes each spoken line with its speaker, in order, in Wan's dialogue syntax", () => {
    const text = describeDialogue([
      { character: "Pip", line: "Puddles!" },
      { character: "Mila", line: " Let's count them! " },
      { character: "Pip", line: "  " },
    ]);
    expect(text).toContain('Pip says: "Puddles!" Lip sync.');
    expect(text).toContain('Mila says: "Let\'s count them!" Lip sync.');
    expect(text.indexOf("Pip says")).toBeLessThan(text.indexOf("Mila says"));
    expect(text.match(/says:/g)).toHaveLength(2);
    expect(text).toContain("never slowed or stretched");
    expect(text).toContain("No other dialogue.");
  });

  it("keeps listeners' mouths closed on each line, including on-screen characters without lines", () => {
    const text = describeDialogue(
      [
        { character: "Papa", line: "What shape is it?" },
        { character: "Mila", line: "A rectangle!" },
      ],
      ["Mila", "Papa", "Zip"],
    );
    expect(text).toContain('Papa says: "What shape is it?" Lip sync. Mila and Zip keep their mouths closed.');
    expect(text).toContain('Mila says: "A rectangle!" Lip sync. Papa and Zip keep their mouths closed.');
    expect(text).toContain("Only one character speaks at a time");
  });

  it("never adds a voice-over: unnamed and narrator lines are left out", () => {
    const text = describeDialogue([
      { character: "", line: "Once upon a time." },
      { character: "Narrator", line: "What fun." },
      { character: "Mila", line: "Hello!" },
    ]);
    expect(text).not.toContain("Once upon a time");
    expect(text).not.toContain("What fun");
    expect(text).not.toMatch(/Voice-over:/);
    expect(text).toContain('Mila says: "Hello!"');
    expect(text).toContain("No narrator or voice-over.");
    expect(describeDialogue([{ character: "", line: "Once upon a time." }])).toBe("");
  });

  it("stamps each line with the second of the beat that quotes it, so speech follows the action", () => {
    const action = [
      "One continuous shot.",
      "0-3s: Both wave. Narrator: \"Good morning! It's exercise time!\"",
      "3-7s: Levon says 'Lie on your back' and rolls back. Yana watches.",
      "7-10s: Yana lies back too. Narrator: \"Yana lies down too.\" Levon's mouth stays closed.",
      "10-13s: Levon says 'Hold!', then counts 'One, two, three!'; Yana joins in with 'Three!'",
    ].join("\r\n");
    const text = describeDialogue(
      [
        { character: "Levon", line: "Lie on your back." },
        { character: "Levon", line: "Hold! One, two, three!" },
        { character: "Yana", line: "Three!" },
      ],
      ["Levon", "Yana"],
      { timeline: parseTimeline(action).segments },
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe(`[3-7s] Levon says: "Lie on your back." Lip sync. Yana's mouth stays closed.`);
    expect(lines[2]).toBe(`[10-13s] Levon says: "Hold! One, two, three!" Lip sync. Yana's mouth stays closed.`);
    expect(lines[3]).toBe(`[10-13s] Yana says: "Three!" Lip sync. Levon's mouth stays closed.`);
    expect(text).toContain("at the second given, in step with the action above");
  });

  it("prefers the beat that quotes a line over an earlier one that merely uses its words", () => {
    const action = [
      "10-13s: Levon says 'Lift your legs' and lifts both legs straight up toward the ceiling. Yana's legs stay down.",
      "13-16s: Yana lifts her legs and says 'Up!' with a big smile. Levon's legs stay up.",
    ].join("\n");
    const text = describeDialogue(
      [
        { character: "Levon", line: "Lift your legs." },
        { character: "Yana", line: "Up!" },
      ],
      ["Levon", "Yana"],
      { timeline: parseTimeline(action).segments },
    );
    expect(text).toContain('[10-13s] Levon says: "Lift your legs."');
    expect(text).toContain('[13-16s] Yana says: "Up!"');
  });

  it("keeps a line the action doesn't quote, unstamped and in order", () => {
    const text = describeDialogue([{ character: "Mila", line: "Hello!" }], ["Mila"], {
      timeline: parseTimeline("0-2s: Mila waves.").segments,
    });
    expect(text).toContain('\nMila says: "Hello!" Lip sync.');
    expect(text).not.toContain("[0-2s]");
    expect(text).toContain("at the moment the action above says they speak");
  });

  it("stamps a line's own timing outside the quotes and wins over the action's beats", () => {
    const text = describeDialogue(
      [
        { character: "Yana", line: "[4-6s] Me too!" },
        { character: "Levon", line: "0–3 s: Let's play firefighters!" },
      ],
      ["Levon", "Yana"],
      { timeline: parseTimeline("2-5s: Levon says 'Let's play firefighters!'").segments },
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe(`[0-3s] Levon says: "Let's play firefighters!" Lip sync. Yana's mouth stays closed.`);
    expect(lines[2]).toBe(`[4-6s] Yana says: "Me too!" Lip sync. Levon's mouth stays closed.`);
    expect(text).toContain("spoken word for word at the second given");
  });

  it("is empty when the scene has no dialogue", () => {
    expect(describeDialogue([])).toBe("");
  });
});

describe("parseDialogueRow", () => {
  it("reads the speaker, the optional timing in its usual spellings, and the spoken text", () => {
    const line = "Let's play firefighters!";
    expect(parseDialogueRow(`Levon: ${line}`)).toEqual({ speaker: "Levon", line, timing: null });
    for (const row of [`Levon: 0-3s: ${line}`, `Levon: 0–3s: ${line}`, `Levon: 0-3 s: ${line}`, `Levon: [0-3s] ${line}`]) {
      expect(parseDialogueRow(row)).toEqual({ speaker: "Levon", line, timing: { start: 0, end: 3 } });
    }
    expect(parseDialogueRow(`Levon: 1.5-3s: ${line}`)?.timing).toEqual({ start: 1.5, end: 3 });
    expect(parseDialogueRow("no speaker")).toBeNull();
  });
});

describe("stripNarration", () => {
  it("removes narrator and voice-over cues, keeping the characters' lines", () => {
    expect(stripNarration(`Both wave. Narrator: "Good morning! It's time!" The children do not speak.`)).toBe(
      "Both wave. The children do not speak.",
    );
    expect(stripNarration("Yana lies down. Voice-over says “Yana lies down too.” Levon is still.")).toBe(
      "Yana lies down. Levon is still.",
    );
    expect(stripNarration("Levon says 'Lie on your back' and rolls back.")).toBe("Levon says 'Lie on your back' and rolls back.");
  });
});

describe("parseTimeline", () => {
  it("reads timed beats in the usual spellings and keeps untimed lines around them", () => {
    const timeline = parseTimeline(
      "Static camera.\n0-3s: wave\r\n3 – 7 s: lie back\n[7-10s] legs up\nShot 4 (0:10-0:13): hold\nNo text.",
    );
    expect(timeline.preamble).toEqual(["Static camera."]);
    expect(timeline.segments).toEqual([
      { start: 0, end: 3, text: "wave" },
      { start: 3, end: 7, text: "lie back" },
      { start: 7, end: 10, text: "legs up" },
      { start: 10, end: 13, text: "hold" },
    ]);
    expect(timeline.notes).toEqual(["No text."]);
  });

  it("doesn't mistake a count or a backwards range for a beat", () => {
    const timeline = parseTimeline("2-3 children wave at the camera.\n5-2s: nonsense");
    expect(timeline.segments).toEqual([]);
    expect(timeline.preamble).toHaveLength(2);
  });
});

describe("buildVideoPrompt", () => {
  const characters = [
    {
      name: "Levon",
      visualDescription: "Slim 5-year-old boy with brown eyes. He wears a plain black T-shirt and white sneakers.",
    },
    { name: "Yana", visualDescription: "Small 2-year-old toddler girl. She wears a white T-shirt with a pink heart." },
  ];
  const scene = {
    visualPrompt: "Both children sit upright on their mats, waving; nobody is lying down yet. No text.",
    action: "0-3s: Both wave. Narrator: \"Good morning!\"\n3-7s: Levon says 'Lie on your back' and lies flat on the green mat.",
    dialogue: [{ character: "Levon", line: "Lie on your back." }],
    characters,
    visualStyle: "Soft 3D animation, pastel colours",
    durationSeconds: 30,
    voiced: true,
  };

  it("with a start image locks look and outfits to the image and leaves the keyframe prompt and bible out", () => {
    const prompt = buildVideoPrompt({ ...scene, startImage: true });
    expect(prompt).toMatch(/^Soft 3D animation, pastel colours\. A 30-second clip that continues from the first-frame image/);
    expect(prompt).toContain("Characters, exactly as in the first frame: Levon (slim 5-year-old boy with brown eyes); Yana (small 2-year-old toddler girl).");
    expect(prompt).toContain("no costume changes");
    expect(prompt).not.toContain("black T-shirt");
    expect(prompt).not.toContain("pink heart");
    expect(prompt).not.toContain("nobody is lying down yet");
    expect(prompt).toContain("Shot 1 [0-3s]: Both wave.\n");
    expect(prompt).toContain("Shot 2 [3-7s]: Levon says 'Lie on your back' and lies flat on the green mat.");
    expect(prompt).not.toContain("Good morning");
    expect(prompt).not.toMatch(/Narrator:|Voice-over:/);
    expect(prompt).toContain(`[3-7s] Levon says: "Lie on your back." Lip sync. Yana's mouth stays closed.`);
    expect(prompt).toContain("No narrator or voice-over.");
    expect(prompt.indexOf("Shot 1")).toBeLessThan(prompt.indexOf("Dialogue, spoken word for word"));
  });

  it("from text keeps the visual prompt and the character bible, since there is no image to lock to", () => {
    const prompt = buildVideoPrompt({ ...scene, startImage: false });
    expect(prompt).toContain("Both children sit upright on their mats");
    expect(prompt).toContain("Keep these characters exactly consistent: Levon: Slim 5-year-old boy");
    expect(prompt).toContain("Visual style: Soft 3D animation, pastel colours.");
    expect(prompt).toContain("Shot 1 [0-3s]: Both wave.");
    expect(prompt).toContain("Outfits, faces and setting stay exactly the same from start to end.");
  });

  it("uses prose action as is, and the visual prompt only when a scene has no action", () => {
    const prose = buildVideoPrompt({ ...scene, startImage: true, action: "Levon lies down, then Yana copies him." });
    expect(prose).toContain("Action: Levon lies down, then Yana copies him.");
    expect(prose).toContain('\nLevon says: "Lie on your back." Lip sync.');
    const legacy = buildVideoPrompt({ ...scene, startImage: true, action: "" });
    expect(legacy).toContain("Both children sit upright on their mats");
  });

  it("asks a silent model for no dialogue text and a voiced model with nothing to say for silence", () => {
    const silent = buildVideoPrompt({ ...scene, startImage: true, voiced: false });
    expect(silent).not.toContain("Dialogue");
    const quiet = buildVideoPrompt({ ...scene, startImage: true, dialogue: [] });
    expect(quiet).toContain("No dialogue, no narrator or voice-over. Quiet ambient sound only; no background music.");
  });

  it("keeps Story QC's continuity requirements when the visual prompt is left out for a start image", () => {
    const visualPrompt = `${scene.visualPrompt}\n\nContinuity requirements:\n- The machine makes exactly two cones, one at a time.`;
    const prompt = buildVideoPrompt({ ...scene, visualPrompt, startImage: true });
    expect(prompt).not.toContain("nobody is lying down yet");
    expect(prompt).toContain("Continuity requirements:\n- The machine makes exactly two cones, one at a time.");
    expect(prompt.indexOf("Continuity requirements:")).toBeLessThan(prompt.indexOf("Dialogue, spoken word for word"));
    expect(buildVideoPrompt({ ...scene, startImage: true })).not.toContain("Continuity requirements:");
    // From text the whole visual prompt is sent, so the block isn't repeated.
    expect(buildVideoPrompt({ ...scene, visualPrompt, startImage: false }).split("Continuity requirements:")).toHaveLength(2);
  });

  it("ends every clip prompt with the quality rules, and the audio rules only for a voiced model", () => {
    for (const startImage of [true, false]) {
      const voiced = buildVideoPrompt({ ...scene, startImage });
      expect(voiced.endsWith(`${VIDEO_QUALITY_RULES}

${AUDIO_QUALITY_RULES}`)).toBe(true);
      expect(voiced).not.toContain(IMAGE_QUALITY_RULES);
    }
    const silent = buildVideoPrompt({ ...scene, startImage: true, voiced: false });
    expect(silent.endsWith(VIDEO_QUALITY_RULES)).toBe(true);
    expect(silent).not.toContain(AUDIO_QUALITY_RULES);
  });

  describe("music in generated clips", () => {
    const silent = { ...scene, startImage: true, dialogue: [] };
    // The audio section comes right before the quality rules that close every voiced prompt.
    const rules = `\n\n${VIDEO_QUALITY_RULES}\n\n${AUDIO_QUALITY_RULES}`;

    it('"none" keeps clips free of music, whatever the mood', () => {
      const music = clipMusicMood("none", sampleContent, { position: 0, title: "Rainy morning" });
      expect(music).toBeNull();
      const prompt = buildVideoPrompt({ ...silent, music });
      expect(prompt.endsWith(`No dialogue, no narrator or voice-over. Quiet ambient sound only; no background music.${rules}`)).toBe(true);
      expect(prompt).not.toContain("Audio:");
      expect(prompt).toBe(buildVideoPrompt(silent));
      expect(buildVideoPrompt({ ...scene, startImage: true, music }).endsWith(`No background music.${rules}`)).toBe(true);
    });

    it('"from music mood" ends the prompt with the scene\'s mood instead of "no background music"', () => {
      const music = clipMusicMood("music_mood", sampleContent, { position: 0, title: "Rainy morning" });
      expect(music).toBe("Light ukulele");
      const prompt = buildVideoPrompt({ ...silent, music });
      expect(prompt.endsWith(`\n\nAudio: Light ukulele, soft and quiet under ambient sounds. No voices, no singing.${rules}`)).toBe(true);
      expect(prompt).not.toMatch(/no background music/i);
      expect(prompt).toContain("No dialogue, no narrator or voice-over.");
      expect(prompt).not.toContain("Good morning");
    });

    it("keeps the dialogue and only rules out other voices when the scene has lines", () => {
      const prompt = buildVideoPrompt({ ...scene, startImage: true, music: "Gentle harp." });
      expect(prompt).toContain('Levon says: "Lie on your back." Lip sync.');
      expect(prompt).toContain("No other dialogue. No narrator or voice-over.\n\nAudio: Gentle harp, soft and quiet under the dialogue");
      expect(prompt).not.toMatch(/no background music/i);
      expect(prompt.endsWith(`No other voices, no singing.${rules}`)).toBe(true);
    });

    it("falls back to the story's overall mood, and asks silent models for nothing", () => {
      const noSceneMood = { ...sampleContent, scenes: sampleContent.scenes.map((s) => ({ ...s, musicMood: "" })) };
      expect(clipMusicMood("music_mood", noSceneMood, { position: 1, title: "Counting puddles" })).toBe("Cheerful and gentle");
      expect(clipMusicMood("music_mood", sampleContent, { position: 1, title: "Renamed scene" })).toBe("Bouncy");
      expect(clipMusicMood("music_mood", null, { position: 0, title: "Rainy morning" })).toBeNull();
      expect(buildVideoPrompt({ ...silent, voiced: false, music: "Bouncy" })).not.toContain("Audio:");
    });
  });
});

describe("describeReferenceImages", () => {
  it("maps each attached image to its characters in order", () => {
    expect(describeReferenceImages([["Mila"], ["Papa"]])).toContain("image 1 shows Mila; image 2 shows Papa");
    expect(describeReferenceImages([["Mila", "Papa", "Zip"]])).toContain("image 1 shows Mila, Papa and Zip");
    expect(describeReferenceImages([])).toBe("");
  });

  it("describes scene references after the character references", () => {
    const text = describeReferenceImages([["Mila"]], 2);
    expect(text).toContain("image 1 shows Mila");
    expect(text).toContain("Images 2 to 3 show the setting, props and objects");
    expect(describeReferenceImages([], 1)).toMatch(/^Image 1 shows the setting/);
  });

  it("names the images @image_N for Kling", () => {
    const text = describeReferenceImages([["Mila"], ["Papa"]], 2, true);
    expect(text).toContain("@image_1 shows Mila; @image_2 shows Papa");
    expect(text).toContain("@image_3 and @image_4 show the setting, props and objects");
    expect(describeReferenceImages([], 1, true)).toMatch(/^@image_1 shows the setting/);
  });
});

describe("findPromptConcerns", () => {
  it("flags existing franchises and studios", () => {
    expect(findPromptConcerns("A pig that looks like Peppa Pig")[0]).toContain("peppa pig");
    expect(findPromptConcerns("Disney-like castle")[0]).toContain("disney");
  });

  it("flags imitating an artist's style", () => {
    expect(findPromptConcerns("A forest in the style of a famous painter")).toHaveLength(1);
  });

  it("doesn't flag ordinary words that contain a name", () => {
    expect(findPromptConcerns("Elmore the legolike block builder with frozen peas")).toEqual([]);
    expect(findPromptConcerns("Original duckling, soft 3D, pastel")).toEqual([]);
  });
});

describe("scenesFromStory", () => {
  it("imports scenes in storyboard order with defaults", () => {
    const shuffled = { scenes: [...sampleContent.scenes].reverse() };
    const drafts = scenesFromStory(shuffled);
    expect(drafts.map((d) => d.title)).toEqual(sampleContent.scenes.map((s) => s.title));
    expect(drafts[0]).toMatchObject({
      narration: sampleContent.scenes[0].narration,
      visualPrompt: sampleContent.scenes[0].visualPrompt,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      notes: sampleContent.scenes[0].productionNotes,
      characterNames: ["Pip"],
    });
  });

  it("clamps durations to a sensible range", () => {
    expect(clampDuration(0)).toBe(5);
    expect(clampDuration(12.4)).toBe(12);
    expect(clampDuration(5000)).toBe(600);
  });
});

describe("moveInOrder", () => {
  it("swaps neighbours and ignores moves past the ends", () => {
    expect(moveInOrder(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b"], "a", "up")).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], "x", "up")).toEqual(["a", "b"]);
  });
});

describe("forms", () => {
  it("parses a scene form, including dialogue and characters", () => {
    const form = new FormData();
    form.set("title", " Rainy morning ");
    form.set("durationSeconds", "8");
    form.set("dialogue", "Pip: Puddles!\nWhat fun");
    form.append("characterIds", "6f1c2f8e-7d3b-4a5e-9c1d-2b3a4c5d6e7f");
    const parsed = parseSceneForm(form);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      title: "Rainy morning",
      durationSeconds: 8,
      dialogue: [
        { character: "Pip", line: "Puddles!" },
        { character: "Narrator", line: "What fun" },
      ],
      characterIds: ["6f1c2f8e-7d3b-4a5e-9c1d-2b3a4c5d6e7f"],
    });
  });

  it("rejects invalid scene durations", () => {
    const form = new FormData();
    form.set("title", "Scene");
    form.set("durationSeconds", "0");
    expect(parseSceneForm(form).success).toBe(false);
  });

  it("requires a usable visual description for characters", () => {
    const form = new FormData();
    form.set("name", "Pip");
    form.set("visualDescription", "duck");
    expect(parseCharacterForm(form).success).toBe(false);
    form.set("visualDescription", "Small round yellow duckling with a blue raincoat");
    expect(parseCharacterForm(form).data).toMatchObject({ name: "Pip", status: "draft" });
  });
});
