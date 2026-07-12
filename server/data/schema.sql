-- PostgreSQL Database Schema for Multi-User Voice Calendar Assistant

-- 1. Users table tracking identity via Google Email
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Google OAuth credentials table (Access / Refresh tokens encrypted via AES-256-GCM)
CREATE TABLE IF NOT EXISTS google_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,         -- Encrypted
    refresh_token TEXT NOT NULL,        -- Encrypted
    expiry_date BIGINT NOT NULL,        -- Millisecond epoch timestamp
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance optimizations
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
