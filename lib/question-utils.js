// lib/question-utils.js — Shared question extraction (5E)
// Eliminates the 6x duplicated pattern:
//   questionData.questions || (questionData.question ? [questionData] : [])

function extractQuestions(data) {
  if (!data) return [];
  return data.questions || (data.question ? [data] : []);
}

module.exports = { extractQuestions };
