export const PREDICTOR_STATE_LENGTH = 7;
export const PREDICTOR_POINT_STRIDE = 4;
export const PREDICTOR_EVENT_STRIDE = 6;
export const PREDICTOR_MAX_POINTS = 2_000;
export const PREDICTOR_BASE_HORIZON_SEC = 90 * 24 * 60 * 60;

export const PREDICTOR_POINT_TIME_SEC_OFFSET = 0;
export const PREDICTOR_POINT_X_KM_OFFSET = 1;
export const PREDICTOR_POINT_Y_KM_OFFSET = 2;
export const PREDICTOR_POINT_Z_KM_OFFSET = 3;

export const PREDICTOR_EVENT_CODE_OFFSET = 0;
export const PREDICTOR_EVENT_TIME_SEC_OFFSET = 1;
export const PREDICTOR_EVENT_BODY_INDEX_OFFSET = 2;
export const PREDICTOR_EVENT_SECONDARY_BODY_INDEX_OFFSET = 3;
export const PREDICTOR_EVENT_DISTANCE_KM_OFFSET = 4;
export const PREDICTOR_EVENT_TIME_TO_IMPACT_SEC_OFFSET = 5;

export const PredictorEventCode = Object.freeze({
  SoiTransition: 1,
  ClosestApproach: 2,
  Impact: 3,
} as const);

export type PredictorEventCode = (typeof PredictorEventCode)[keyof typeof PredictorEventCode];
