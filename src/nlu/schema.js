// Gemini structured-output schema for parsing Hebrew family-management messages.
// The Generative AI SDK uses an OpenAPI-3-style schema. Enums are uppercase
// strings on `SchemaType`, but we only need the string literals.

export const NLU_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['add-event', 'mark-task-done', 'query-schedule', 'unknown'],
    },
    confidence: {
      type: 'number',
      description: 'Model confidence in the intent classification, 0..1',
    },
    payload: {
      type: 'object',
      description:
        'Intent-specific fields. Empty object for unknown intent. ' +
        'For add-event: { title, startTime (ISO Asia/Jerusalem), endTime (ISO, optional), location (string|null), attendees (array of names, optional), category (one of work|personal|school|family|medical|other) }. ' +
        'For mark-task-done: { taskTitle, forDate (YYYY-MM-DD) }. ' +
        'For query-schedule: { window (one of today|tomorrow|this-week) }.',
      properties: {
        title: { type: 'string' },
        startTime: { type: 'string' },
        endTime: { type: 'string' },
        location: { type: 'string', nullable: true },
        attendees: {
          type: 'array',
          items: { type: 'string' },
        },
        category: {
          type: 'string',
          enum: ['work', 'personal', 'school', 'family', 'medical', 'other'],
        },
        taskTitle: { type: 'string' },
        forDate: { type: 'string' },
        window: {
          type: 'string',
          enum: ['today', 'tomorrow', 'this-week'],
        },
      },
    },
  },
  required: ['intent', 'confidence', 'payload'],
};
