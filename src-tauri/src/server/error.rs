use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::proto::EntryProto;

/// 网关自身错误;按入口协议渲染错误 JSON(状态码原样)
#[derive(Debug, Clone)]
pub struct GatewayError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl GatewayError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self { status: 400, code: "invalid_request_error", message: message.into() }
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self { status: 401, code: "authentication_error", message: message.into() }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self { status: 404, code: "not_found_error", message: message.into() }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self { status: 500, code: "gateway_error", message: message.into() }
    }
    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self { status: 503, code: "gateway_error", message: message.into() }
    }

    pub fn render(&self, entry: EntryProto) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = match entry {
            EntryProto::OpenAi | EntryProto::Responses => json!({
                "error": {"message": self.message, "type": self.code, "code": self.code}
            }),
            EntryProto::Anthropic => json!({
                "type": "error",
                "error": {"type": self.anthropic_type(), "message": self.message}
            }),
            EntryProto::Gemini => json!({
                "error": {"code": self.status, "message": self.message, "status": self.gemini_status()}
            }),
        };
        (status, Json(body)).into_response()
    }

    fn anthropic_type(&self) -> &'static str {
        match self.status {
            400 => "invalid_request_error",
            401 => "authentication_error",
            403 => "permission_error",
            404 => "not_found_error",
            429 => "rate_limit_error",
            503 => "overloaded_error",
            _ => "api_error",
        }
    }

    fn gemini_status(&self) -> &'static str {
        match self.status {
            400 => "INVALID_ARGUMENT",
            401 | 403 => "PERMISSION_DENIED",
            404 => "NOT_FOUND",
            429 => "RESOURCE_EXHAUSTED",
            503 => "UNAVAILABLE",
            _ => "INTERNAL",
        }
    }
}
