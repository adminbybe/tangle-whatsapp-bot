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
      enum: ['add-event', 'mark-task-done', 'query-schedule', 'query-file-expiry', 'unknown'],
      description:
        'One of: add-event (user wants a new calendar event), mark-task-done ' +
        '(user reports a task they completed), query-schedule (user asks what is ' +
        'on their schedule), query-file-expiry (user asks when a document, ' +
        'license, vehicle test, vaccination certificate, or any time-bound file ' +
        'expires), unknown (anything else, including chit-chat).',
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
        'For intent="query-schedule": REQUIRED window (today|tomorrow|this-week|next-week). ' +
        'For intent="query-file-expiry": REQUIRED searchQuery — the meaningful ' +
        'Hebrew keywords from the question (e.g. user says "מתי הטסט של מזל ' +
        'נגמר?" → searchQuery="טסט מזל"). Strip stop-words like של/את/מתי. ' +
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
          enum: ['today', 'tomorrow', 'this-week', 'next-week'],
          description: 'query-schedule ONLY: which time window the user asked about.',
        },
        searchQuery: {
          type: 'string',
          description:
            'query-file-expiry ONLY: short Hebrew keywords describing the ' +
            'document/asset whose expiry the user is asking about (e.g. ' +
            '"טסט מזל", "ביטוח רכב", "רישיון", "ביטוח חיים"). Drop stop-words.',
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
        'searchQuery',
      ],
    },
  },
  required: ['intent', 'confidence', 'payload'],
  propertyOrdering: ['intent', 'confidence', 'payload'],
};
