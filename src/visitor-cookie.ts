// Shared cookie-name constant. Lives in its own file so both the
// edge-runtime middleware and the server-runtime visitor helper can
// import from it without either module dragging in imports the other
// runtime forbids (middleware can't touch `next/headers`, etc.).

export const VISITOR_COOKIE_NAME = 'visitor_uuid';
