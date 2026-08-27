export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
  timestamp: string;
}

export interface ApiErrorEnvelope {
  success: false;
  data: null;
  message: string;
  statusCode: number;
  path: string;
  timestamp: string;
  errors?: string[];
  details?: unknown;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}
