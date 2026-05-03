// Gemini structured-output schema for parsing Hebrew family-management messages.
// The Generative AI SDK uses an OpenAPI-3-style schema. Gemini's responseSchema
// does NOT support oneOf/anyOf, so we list every possible payload field at the
// top level and rely on the system prompt + few-shots to keep the model from
// mixing fields across intents. `propertyOrdering` is honored by Gemini and
// improves field-by-field generation quality.

export const NLU_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'add-event',
        'mark-task-done',
        'query-schedule',
        'query-file-expiry',
        'query-pet-info',
        'unknown',
      ],
      description:
        'One of: add-event (new calendar event), mark-task-done ' +
        '(user reports a task they completed), query-schedule (what is ' +
        'on the schedule), query-file-expiry (when a document/license/' +
        'insurance/test expires), query-pet-info (free-form facts about a ' +
        'pet — vet contact, food/supplies, medications, conditions, ' +
        'weight), unknown (anything else, including chit-chat).',
    },
    confidence: {
      type: 'number',
      description: 'Model confidence in the intent classification, 0..1.',
    },
    payload: {
      type: 'object',
      description:
        'Intent-specific fields. CRITICAL: only fill fields that belong to the ' +
        'classified intent — never mix fields across intents. ' +
        'For intent="add-event": REQUIRED title (string), REQUIRED startTime ' +
        '(ISO 8601 with +03:00/+02:00 offset, Asia/Jerusalem). Optional endTime, ' +
        'location, attendees, category. If the user did not state a clear time, ' +
        'omit startTime entirely (do NOT guess) and lower confidence. ' +
        'For intent="mark-task-done": REQUIRED taskTitle, REQUIRED forDate (YYYY-MM-DD). ' +
        'For intent="query-schedule": REQUIRED window (today|tomorrow|this-week|next-week|this-month|next-month). ' +
        'OPTIONAL forMembers — array of names/relational terms when the user ' +
        'wants events of specific people / pets ("רק לי", "של מזל", "לי ולאשתי"). ' +
        'Use "self" for the speaker, or person/pet names / relational terms. ' +
        'For intent="query-file-expiry": REQUIRED searchQuery — the meaningful ' +
        'Hebrew keywords from the question (e.g. user says "מתי הטסט של מזל ' +
        'נגמר?" → searchQuery="טסט מזל"). Strip stop-words like של/את/מתי. ' +
        'For intent="query-pet-info": REQUIRED petName + aspect. aspect is ' +
        'one of vet/food/medication/condition/weight. ' +
        'For intent="unknown": empty object {}.',
      properties: {
        title: {
          type: 'string',
          description: 'add-event ONLY: short Hebrew title for the event.',
        },
        startTime: {
          type: 'string',
          description:
            'add-event ONLY: ISO 8601 datetime with explicit +03:00 or +02:00 ' +
            'offset. OMIT this field if the user did not state a specific time.',
        },
        endTime: {
          type: 'string',
          description: 'add-event ONLY: ISO 8601 datetime, optional.',
        },
        location: {
          type: 'string',
          nullable: true,
          description: 'add-event ONLY: place name, or null if not stated.',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description:
            'add-event ONLY: names mentioned by the user. Do NOT invent names.',
        },
        category: {
          type: 'string',
          enum: ['work', 'personal', 'school', 'family', 'medical', 'other'],
          description: 'add-event ONLY: best-fit category.',
        },
        taskTitle: {
          type: 'string',
          description: 'mark-task-done ONLY: short Hebrew title for the task done.',
        },
        forDate: {
          type: 'string',
          description: 'mark-task-done ONLY: YYYY-MM-DD in Asia/Jerusalem.',
        },
        window: {
          type: 'string',
          enum: ['today', 'tomorrow', 'this-week', 'next-week', 'this-month', 'next-month'],
          description: 'query-schedule ONLY: which time window the user asked about.',
        },
        forMembers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'query-schedule ONLY (optional): one or more family members / pets ' +
            'to filter the schedule by. Use "self" for the speaker. Multiple ' +
            'targets give a UNION ("מה יש לי ולאשתי" → ["self", "אשתי"]). ' +
            'Names can be firstName, nickname, pet name, or relational terms ' +
            '("אשתי", "בעלי", "הבן", "הבת", "אבא", "אמא"). Omit only when the ' +
            'user explicitly asks for the full family schedule.',
        },
        strict: {
          type: 'boolean',
          description:
            'query-schedule ONLY (optional): true when the user said "רק" ' +
            '("מה יש רק לי", "מה יש רק למזל") — meaning include events where ' +
            'the target is the SOLE attendee, excluding shared events. ' +
            'Default false: include any event the target appears in.',
        },
        searchQuery: {
          type: 'string',
          description:
            'query-file-expiry ONLY: short Hebrew keywords describing the ' +
            'document/asset whose expiry the user is asking about (e.g. ' +
            '"טסט מזל", "ביטוח רכב", "רישיון", "ביטוח חיים"). Drop stop-words.',
        },
        petName: {
          type: 'string',
          description:
            'query-pet-info ONLY: pet name as the user said it (e.g. "ברי", ' +
            '"כלבה"). The bot resolves it against the pets collection.',
        },
        aspect: {
          type: 'string',
          enum: ['vet', 'food', 'medication', 'condition', 'weight'],
          description:
            'query-pet-info ONLY: which aspect of the pet the user is asking ' +
            'about. vet = vet name/phone, food = supplies (food/treats/litter), ' +
            'medication = current medications, condition = allergies / ' +
            'conditions, weight = latest weight entry.',
        },
      },
      // propertyOrdering nudges Gemini to fill fields in this order, which keeps
      // intent-specific fields grouped and reduces cross-intent contamination.
      propertyOrdering: [
        'title',
        'startTime',
        'endTime',
        'location',
        'attendees',
        'category',
        'taskTitle',
        'forDate',
        'window',
        'forMembers',
        'strict',
        'searchQuery',
        'petName',
        'aspect',
      ],
    },
  },
  required: ['intent', 'confidence', 'payload'],
  propertyOrdering: ['intent', 'confidence', 'payload'],
};
