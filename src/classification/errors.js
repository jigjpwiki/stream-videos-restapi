const codes=new Set(['invalid_classification','duplicate_video_reference','custody_not_committed','missing_publication_date','destination_section_missing','stored_original_row_missing','destination_row_missing']);
export class ClassificationValidationError extends Error {
  constructor(code){super(codes.has(code)?code:'classification_validation_failed');this.name='ClassificationValidationError';this.code=this.message;}
}
export function validationDetails(error){return error instanceof ClassificationValidationError?{reason:error.code}:null;}
