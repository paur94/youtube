import { REVIEW_CHECKS, type StoryContent, type StoryInput } from "@/lib/stories";

export const sampleInput: StoryInput = {
  ideaId: null,
  title: "Pip and the Puddle Count",
  ageGroup: "3-5",
  topic: "A duckling counts puddles on a rainy walk",
  learningObjective: "Count from one to five",
  characters: "Pip – a small yellow duckling",
  targetDurationSeconds: 120,
  tone: "Playful and silly",
  visualStyle: "Soft 3D animation, pastel colours",
  language: "English",
  notes: "",
};

export const sampleContent: StoryContent = {
  title: "Pip Splashes to Five",
  premise: "Pip the duckling counts puddles on the way to Grandma's pond.",
  learningOutcome: "Children practise counting from one to five with repetition.",
  beginning: "Pip wakes up to the sound of rain.",
  middle: "Pip counts each puddle with a splash.",
  ending: "Five puddles later, Pip reaches the pond and counts the friends waiting there.",
  narration: "One rainy morning, Pip heard pitter-patter on the roof…",
  characters: [
    {
      name: "Pip",
      role: "Hero",
      description: "Curious and bouncy",
      visualDescription: "Small round yellow duckling with an orange beak and a blue raincoat",
    },
  ],
  scenes: [
    {
      number: 1,
      title: "Rainy morning",
      durationSeconds: 60,
      setting: "Cosy nest under a willow tree",
      action: "Pip peeks out at the rain",
      narration: "Pitter-patter went the rain.",
      characters: ["Pip"],
      dialogue: [{ character: "Pip", line: "Puddles! Let's count them!" }],
      visualPrompt: "Small round yellow duckling in a blue raincoat peeking out of a nest, soft 3D, pastel",
      soundEffects: ["rain", "giggle"],
      musicMood: "Light ukulele",
    },
    {
      number: 2,
      title: "Counting puddles",
      durationSeconds: 60,
      setting: "Meadow path",
      action: "Pip jumps in five puddles",
      narration: "One, two, three, four, five!",
      characters: ["Pip"],
      dialogue: [],
      visualPrompt: "Yellow duckling splashing in a puddle on a meadow path, soft 3D, pastel",
      soundEffects: ["splash"],
      musicMood: "Bouncy",
    },
  ],
  musicMood: "Cheerful and gentle",
  estimatedDurationSeconds: 115,
  reviewChecklist: REVIEW_CHECKS.map((check) => ({ check, status: "pass" as const, note: "OK" })),
};
