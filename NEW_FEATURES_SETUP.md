# New Features — Setup Guide

## Overview of changes
Three new features added on top of the existing Risk Score, Care Gaps, Discharge Summary, and Pre-Visit Summary plugins.

---

## Feature 1: Manual Data Entry (no n8n required)
Posts directly to your HAPI FHIR R4 server.

Supports:
- **Labs** → FHIR `Observation` (category: laboratory)
- **Vitals** → FHIR `Observation` (category: vital-signs) — BP, HR, Temp, SpO2, RR, Weight, Height
- **Medications** → FHIR `MedicationRequest`
- **Conditions** → FHIR `Condition`
- **Allergies** → FHIR `AllergyIntolerance`

**"Keep previous" logic:**
- Only filled-in fields are posted as new FHIR resources
- Blank fields are never overwritten — existing FHIR entries remain with their original dates
- Each field post is a *new* FHIR resource timestamped to the date you provide

---

## Feature 2: PDF Report Upload via n8n

### n8n webhook required: `process-report`
Create a POST webhook at path: `process-report`

**Receives:**
```json
{
  "patientId": "123",
  "fhirBase": "http://...",
  "pdfBase64": "<base64 string>",
  "filename": "lab_report.pdf",
  "reportType": "labs",
  "keepPrevious": true,
  "showDates": true,
  "patientName": "Smith, John"
}
```

**Must return:**
```json
{
  "reportDate": "2024-01-15",
  "summary": "CBC panel, lipid panel extracted",
  "extracted": [
    { "name": "Hemoglobin", "value": 14.2, "unit": "g/dL", "date": "2024-01-15", "isNew": true },
    { "name": "Cholesterol", "value": 195, "unit": "mg/dL", "date": "2023-11-01", "isNew": false }
  ],
  "resources": [
    {
      "resourceType": "Observation",
      "status": "final",
      "category": [{ "coding": [{ "system": "...", "code": "laboratory" }] }],
      "code": { "text": "Hemoglobin" },
      "subject": { "reference": "Patient/123" },
      "effectiveDateTime": "2024-01-15T00:00:00Z",
      "valueQuantity": { "value": 14.2, "unit": "g/dL" }
    }
  ]
}
```

**Recommended n8n workflow:**
1. Webhook (POST) → receive payload
2. Code node → decode base64 PDF
3. Claude/OpenAI node → extract structured values from PDF text
4. Code node → build FHIR resources + merge with previous (fetch from FHIR using fhirBase)
5. Respond to webhook with extracted + resources

---

## Feature 3: Live Doctor–Patient Consultation

### Two n8n webhooks required:

#### 3a. `generate-clinical-notes` (POST)
Generates SOAP-format clinical notes from the conversation transcript.

**Receives:**
```json
{
  "patientId": "123",
  "fhirBase": "http://...",
  "patientName": "Smith, John",
  "transcript": "[09:01:23] Doctor: Patient presents with...\n[09:01:45] Patient: I've had chest pain...",
  "rawTranscript": [
    { "speaker": "doctor", "text": "...", "time": "09:01:23" }
  ]
}
```

**Must return:**
```json
{
  "html": "<div><h4>S – Subjective</h4><p>Patient reports...</p><h4>O – Objective</h4>...</div>"
}
```

#### 3b. `extract-chart-updates` (POST)
Extracts structured chart updates from the conversation.

**Receives:** Same as above

**Must return:**
```json
{
  "html": "<p>Proposed updates: New condition: Hypertension...</p>",
  "resources": [
    {
      "resourceType": "Condition",
      "clinicalStatus": { "coding": [{ "code": "active" }] },
      "code": { "text": "Hypertension" },
      "subject": { "reference": "Patient/123" }
    }
  ]
}
```

**Recommended n8n workflow for both:**
1. Webhook (POST) → receive transcript
2. Claude/OpenAI node → analyze conversation
3. Code node → build FHIR resources from mentions of symptoms, meds, vitals
4. Respond to webhook

---

## Speech Recognition
The Live Consultation panel uses the **Web Speech API** (built into Chrome/Edge/Safari).
- If the browser supports it: click Start → real microphone transcription begins per speaker
- If not supported (Firefox, non-HTTPS): use the text input fallback to type what's being said
- Toggle speaker between Doctor and Patient before each person speaks

## Saving Clinical Notes to FHIR
"Save Notes to Chart" posts a `DocumentReference` FHIR resource with the full SOAP note attached as a text document.
