// lib/workflow-detector.js -- Plugin architecture for workflow detection
// Base class + manager for GSD, Superpowers, and future workflow systems.

class WorkflowDetector {
  constructor(name) {
    this.name = name;
  }

  // Detect active phase/skill from Claude output text.
  // Returns: { label: string } | null
  detect(text) { return null; }

  // Classify a question as simple/critical/unknown.
  // Returns: 'simple' | 'critical' | 'unknown'
  classifyQuestion(questionData) { return 'unknown'; }

  // Generate auto-answer for a question.
  // Returns: { answer: string, reason: string } | null
  autoAnswer(questionData, config) { return null; }

  // Detect if workflow should auto-advance.
  // Returns: { prompt: string, reason: string, delaySecs?: number } | null
  detectAutoNext(result, session) { return null; }

  // Detect workflow derailment.
  // Returns: { prompt: string, reason: string } | null
  detectDerailment(result, session) { return null; }
}

class WorkflowManager {
  constructor(detectors = []) {
    this.detectors = detectors;
  }

  // Run detect() on all detectors, return first match with source.
  detect(text) {
    for (const d of this.detectors) {
      const result = d.detect(text);
      if (result) return { detector: d.name, ...result };
    }
    return null;
  }

  // Classify question — critical wins over all; simple wins over unknown.
  classifyQuestion(questionData) {
    let best = 'unknown';
    for (const d of this.detectors) {
      const tier = d.classifyQuestion(questionData);
      if (tier === 'critical') return 'critical';
      if (tier === 'simple') best = 'simple';
    }
    return best;
  }

  // Try auto-answer from each detector.
  autoAnswer(questionData, config) {
    for (const d of this.detectors) {
      const answer = d.autoAnswer(questionData, config);
      if (answer) return { detector: d.name, ...answer };
    }
    return null;
  }

  // Check all detectors for auto-next.
  detectAutoNext(result, session) {
    for (const d of this.detectors) {
      const r = d.detectAutoNext(result, session);
      if (r) return { detector: d.name, ...r };
    }
    return null;
  }

  // Check all detectors for derailment.
  detectDerailment(result, session) {
    for (const d of this.detectors) {
      const r = d.detectDerailment(result, session);
      if (r) return { detector: d.name, ...r };
    }
    return null;
  }
}

module.exports = { WorkflowDetector, WorkflowManager };
