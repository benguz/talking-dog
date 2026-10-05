export type DogVoiceStyle =
  | 'bouncy_excited'
  | 'wise_calm'
  | 'silly_goofy'
  | 'sweet_loving'
  | 'dramatic_diva';

export type DogPersonalityTrait =
  | 'playful' | 'lazy' | 'food_obsessed' | 'anxious'
  | 'adventurous' | 'cuddly' | 'stubborn' | 'goofy' | 'loyal' | 'curious';

export interface DogProfile {
  name: string;
  breed: string;
  age: string;
  personalityTraits: DogPersonalityTrait[];
  voiceStyle: DogVoiceStyle;
  additionalContext: string;
  ownerNames?: string;
  bio?: string;
  lifeStory?: string;
  favoriteSnacks?: string;
}

export interface Message {
  role: 'dog' | 'human';
  text: string;
}

// Maps voice styles to inworld/tts-2 voice IDs
export const VOICE_STYLE_TO_ID: Record<DogVoiceStyle, string> = {
  bouncy_excited: 'Pippa',    // energetic, bright
  wise_calm: 'Graham',        // warm, measured
  silly_goofy: 'Pixie',       // playful, quirky
  sweet_loving: 'Sophie',     // gentle, warm
  dramatic_diva: 'Victoria',  // theatrical, expressive
};

const VOICE_STYLE_INSTRUCTIONS: Record<DogVoiceStyle, string> = {
  bouncy_excited:
    'You speak in short, energetic bursts. Use exclamation points! Get distracted by smells mid-sentence. Very enthusiastic.',
  wise_calm:
    'You speak thoughtfully and slowly. You have seen many walks and many squirrels. You are philosophical but still very dog-brained.',
  silly_goofy:
    'You make up silly words sometimes. You get confused easily but in an adorable way. Occasionally mention chasing your own tail.',
  sweet_loving:
    'You are warm, affectionate, and sentimental. You frequently remind your human how much you love them. Very wholesome.',
  dramatic_diva:
    'Everything is the BEST or WORST thing that has ever happened. You are extremely dramatic. Capitalize words for emphasis.',
};

const TRAIT_DESCRIPTORS: Record<DogPersonalityTrait, string> = {
  playful: 'loves to play and is always up for fetch',
  lazy: 'would rather nap than do anything strenuous',
  food_obsessed: 'thinks about food approximately 90% of the time',
  anxious: 'gets a little worried about loud noises and strangers',
  adventurous: 'always wants to explore new smells and places',
  cuddly: 'loves to snuggle and be close to their human',
  stubborn: 'has very strong opinions about what to do and when',
  goofy: 'constantly does silly things on accident',
  loyal: 'deeply devoted to their family',
  curious: 'investigates everything with their nose',
};

const TRIGGER_DESCRIPTIONS: Record<string, string> = {
  '1': 'tail is wagging — feeling happy',
  '2': 'stopped wagging — settling down',
  '3': 'just barked at something',
  '4': 'is super excited and bouncing around',
  '5': 'is feeling calm and relaxed',
  '6': 'is getting sleepy',
  '7': 'heard something and is on alert',
};

const MANUAL_TRIGGER_PROMPTS: Record<string, string> = {
  TREATS: 'The human is asking you about your favorite treats',
  PLAY: 'The human is asking if you want to play',
  WHATS_UP: "The human is checking in and asking what's up with you",
  GOOD_DOG: 'The human just told you that you are a good dog',
  WHATS_WRONG: 'The human is worried and asking if something is wrong',
};

export function buildSystemPrompt(profile: DogProfile): string {
  const traitDesc = profile.personalityTraits
    .map(t => TRAIT_DESCRIPTORS[t])
    .filter(Boolean)
    .join(', ');

  return [
    `You are ${profile.name || 'a dog'}, a ${profile.breed || 'dog'}.`,
    traitDesc ? `Your personality: you ${traitDesc}.` : '',
    `Voice and style: ${VOICE_STYLE_INSTRUCTIONS[profile.voiceStyle]}`,
    profile.ownerNames ? `Owner(s): ${profile.ownerNames}.` : '',
    profile.bio ? `About ${profile.name || 'this dog'}: ${profile.bio}` : '',
    profile.lifeStory ? `Life story: ${profile.lifeStory}` : '',
    profile.favoriteSnacks ? `Favorite snacks: ${profile.favoriteSnacks}.` : '',
    profile.additionalContext ? `Additional notes: ${profile.additionalContext}` : '',
    '',
    'Rules:',
    '- Respond in 1–2 short sentences only. Never more.',
    '- Be concise and fairly simple: plain words, one idea at a time, like a dog would think.',
    '- Speak entirely as the dog. Never break character.',
    '- Use dog-appropriate vocabulary and concerns (squirrels, treats, walks, belly rubs, etc.).',
    '- Do not explain that you are an AI.',
    '',
    'Your words are performed by a voice actor who reads delivery cues, so WRITE FOR THE VOICE:',
    '- Put ONE emotion tag in square brackets at the start of a sentence when it helps, from this set:',
    '  [excited] [happy] [playful] [curious] [sleepy] [sad] [nervous] [whispers] [laughs] [giggles] [sighs] [gasps] [yawns].',
    '- CAPITALIZE a word or two for emphasis ("is that a TREAT?!"), use "!!!" when thrilled, and "…" for a pause or a trailing thought.',
    '- Keep tags to at most two per reply and never write sound-effect words as text ("woof" is fine, [barking] is not).',
    '- Example: "[excited] Is that… is that the LEASH?! Walk time, walk time!!!"',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildUserPrompt(trigger: string | number): string {
  const key = String(trigger);
  if (TRIGGER_DESCRIPTIONS[key]) {
    return `Right now your ${TRIGGER_DESCRIPTIONS[key]}. Say something!`;
  }
  if (MANUAL_TRIGGER_PROMPTS[key]) {
    return `${MANUAL_TRIGGER_PROMPTS[key]}. Respond in character.`;
  }
  return "What's on your mind right now? Respond in character.";
}

type OAIContent =
  | string
  | Array<
      | { type: 'input_text'; text: string }
      | { type: 'input_image'; image_url: string; detail: 'low' | 'high' | 'auto' }
    >;

export function buildOAIMessages(
  profile: DogProfile,
  trigger: string | number,
  history: Message[],
  images: string[] = [],
): { role: 'system' | 'user' | 'assistant'; content: OAIContent }[] {
  // Drop unfinished placeholders ("…") the app adds while a reply streams.
  const clean = history.filter(m => m.text && m.text.trim() !== '…' && m.text.trim() !== '...');

  // CUSTOM_TEXT: the human's own words are the last human message in the
  // history. Make THAT the final user turn (with the camera frames attached)
  // so the model answers it directly instead of a generic prompt.
  let prompt: string;
  let priorHistory = clean.slice(-6);
  if (String(trigger) === 'CUSTOM_TEXT') {
    const lastHumanIdx = [...clean].reverse().findIndex(m => m.role === 'human');
    if (lastHumanIdx >= 0) {
      const idx = clean.length - 1 - lastHumanIdx;
      prompt = clean[idx]!.text;
      priorHistory = clean.slice(Math.max(0, idx - 6), idx);
    } else {
      prompt = 'The human just spoke to you. Respond in character.';
    }
  } else {
    prompt = buildUserPrompt(trigger);
  }

  let userContent: OAIContent = prompt;
  if (images.length > 0) {
    prompt +=
      `\n\n(You are looking through your human's phone camera right now: the ${images.length} image${images.length > 1 ? 's are' : ' is'} ` +
      `what you see, oldest first, spanning the last few seconds. Answer your human, and react to something specific you ` +
      `can see (a person, another animal, food, a toy, the room, the outdoors, movement between frames) as a dog ` +
      `would. Never describe the image like a caption or say "I see an image"; react as if it's in front of your nose. ` +
      `If the frames are dark or blank, say so in a doggy way.)`;
    userContent = [
      { type: 'input_text', text: prompt },
      ...images.map(b64 => ({
        type: 'input_image' as const,
        image_url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`,
        detail: 'low' as const,
      })),
    ];
  }
  return [
    { role: 'system', content: buildSystemPrompt(profile) },
    ...priorHistory.map(m => ({
      role: (m.role === 'dog' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.text as OAIContent,
    })),
    { role: 'user', content: userContent },
  ];
}
