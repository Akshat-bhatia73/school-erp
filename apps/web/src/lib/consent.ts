/**
 * Plain English for the consent vocabulary in @erp/contracts, so the admission form, the student
 * profile and the parent home all say the same thing about the same purpose.
 */
import type { ConsentMethod, ConsentPurpose } from '@erp/contracts'

export const PURPOSE_LABEL: Record<ConsentPurpose, string> = {
  education_records: 'School records',
  health_information: 'Health information',
  photographs: 'Photographs',
  communication: 'Messages from the school',
  third_party_services: 'Services run by others',
}

export const PURPOSE_DESCRIPTION: Record<ConsentPurpose, string> = {
  education_records: 'Keeping marks, attendance and class history for this child.',
  health_information: 'Holding blood group, allergies and medical notes.',
  photographs: 'Using photographs of this child in school material.',
  communication: 'Sending messages about school matters to this guardian.',
  third_party_services: 'Sharing what is needed with services the school uses.',
}

export const METHOD_LABEL: Record<ConsentMethod, string> = {
  in_person: 'Given in person',
  signed_form: 'Signed form',
  portal: 'Given by the guardian online',
}
