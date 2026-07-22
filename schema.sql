-- AustinLab Cockpit Database Schema
-- PostgreSQL schema for health, fitness, study, career, and finance tracking

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable JSON extension
CREATE EXTENSION IF NOT EXISTS "hstore";

-- ============================================================================
-- USERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  avatar_url TEXT,
  timezone VARCHAR(50) DEFAULT 'UTC',
  preferences JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT true,
  email_verified BOOLEAN DEFAULT false,
  email_verified_at TIMESTAMP WITH TIME ZONE,
  two_factor_enabled BOOLEAN DEFAULT false
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_created_at ON users(created_at);

-- ============================================================================
-- CONNECTIONS TABLE (Third-party API tokens and credentials)
-- ============================================================================
CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  provider_account_id VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_type VARCHAR(50),
  expires_at TIMESTAMP WITH TIME ZONE,
  scope TEXT,
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider)
);

CREATE INDEX idx_connections_user_id ON connections(user_id);
CREATE INDEX idx_connections_provider ON connections(provider);
CREATE INDEX idx_connections_is_active ON connections(is_active);

-- ============================================================================
-- SUBSCRIPTIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  plan VARCHAR(50) NOT NULL DEFAULT 'starter',
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMP WITH TIME ZONE,
  current_period_end TIMESTAMP WITH TIME ZONE,
  cancel_at TIMESTAMP WITH TIME ZONE,
  canceled_at TIMESTAMP WITH TIME ZONE,
  cancellation_reason TEXT,
  auto_renewal BOOLEAN DEFAULT true,
  price DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'USD',
  billing_cycle VARCHAR(20),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_subscriptions_current_period_end ON subscriptions(current_period_end);

-- ============================================================================
-- DASHBOARDS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS dashboards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  notion_database_id VARCHAR(255) UNIQUE,
  notion_page_id VARCHAR(255),
  dashboard_type VARCHAR(50) NOT NULL DEFAULT 'personal',
  layout JSONB DEFAULT '{}',
  categories JSONB DEFAULT '["Health & Fitness", "Study", "Career", "Finance"]',
  settings JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  is_shared BOOLEAN DEFAULT false,
  shared_with JSONB DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_dashboards_user_id ON dashboards(user_id);
CREATE INDEX idx_dashboards_notion_database_id ON dashboards(notion_database_id);
CREATE INDEX idx_dashboards_is_active ON dashboards(is_active);
CREATE INDEX idx_dashboards_dashboard_type ON dashboards(dashboard_type);

-- ============================================================================
-- SYNC_LOGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id UUID REFERENCES dashboards(id) ON DELETE SET NULL,
  sync_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  source_system VARCHAR(100),
  target_system VARCHAR(100),
  records_synced INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  error_message TEXT,
  error_details JSONB,
  metadata JSONB DEFAULT '{}',
  duration_ms INTEGER,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sync_logs_user_id ON sync_logs(user_id);
CREATE INDEX idx_sync_logs_dashboard_id ON sync_logs(dashboard_id);
CREATE INDEX idx_sync_logs_status ON sync_logs(status);
CREATE INDEX idx_sync_logs_sync_type ON sync_logs(sync_type);
CREATE INDEX idx_sync_logs_created_at ON sync_logs(created_at);

-- ============================================================================
-- EVENTS TABLE (Telemetry and analytics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_name VARCHAR(255) NOT NULL,
  event_category VARCHAR(100),
  properties JSONB DEFAULT '{}',
  user_agent TEXT,
  ip_address VARCHAR(45),
  session_id VARCHAR(255),
  device_type VARCHAR(50),
  os_name VARCHAR(100),
  os_version VARCHAR(100),
  browser_name VARCHAR(100),
  browser_version VARCHAR(100),
  source VARCHAR(100),
  revenue DECIMAL(10, 2),
  currency VARCHAR(3),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_event_name ON events(event_name);
CREATE INDEX idx_events_event_category ON events(event_category);
CREATE INDEX idx_events_created_at ON events(created_at);
CREATE INDEX idx_events_session_id ON events(session_id);

-- ============================================================================
-- HEALTH_DATA TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS health_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_date DATE NOT NULL,
  steps INTEGER DEFAULT 0,
  distance_km DECIMAL(10, 2) DEFAULT 0,
  calories_burned INTEGER DEFAULT 0,
  active_minutes INTEGER DEFAULT 0,
  heart_rate_avg INTEGER,
  heart_rate_min INTEGER,
  heart_rate_max INTEGER,
  sleep_minutes INTEGER DEFAULT 0,
  sleep_quality VARCHAR(50),
  water_intake_ml INTEGER DEFAULT 0,
  workouts JSONB DEFAULT '[]',
  source VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, data_date, source)
);

CREATE INDEX idx_health_data_user_id ON health_data(user_id);
CREATE INDEX idx_health_data_data_date ON health_data(data_date);
CREATE INDEX idx_health_data_user_date ON health_data(user_id, data_date);

-- ============================================================================
-- STUDY_DATA TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS study_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_date DATE NOT NULL,
  topic VARCHAR(255) NOT NULL,
  hours_studied DECIMAL(5, 2) NOT NULL,
  flashcards_completed INTEGER DEFAULT 0,
  quiz_score DECIMAL(5, 2),
  notes TEXT,
  resources JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_study_data_user_id ON study_data(user_id);
CREATE INDEX idx_study_data_study_date ON study_data(study_date);
CREATE INDEX idx_study_data_topic ON study_data(topic);

-- ============================================================================
-- CAREER_DATA TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS career_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_date DATE NOT NULL,
  task_name VARCHAR(255) NOT NULL,
  project VARCHAR(255),
  task_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  priority VARCHAR(50),
  hours_spent DECIMAL(5, 2) DEFAULT 0,
  meetings_count INTEGER DEFAULT 0,
  goals_achieved INTEGER DEFAULT 0,
  notes TEXT,
  attachments JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_career_data_user_id ON career_data(user_id);
CREATE INDEX idx_career_data_task_date ON career_data(task_date);
CREATE INDEX idx_career_data_project ON career_data(project);
CREATE INDEX idx_career_data_task_status ON career_data(task_status);

-- ============================================================================
-- FINANCE_DATA TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS finance_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_date DATE NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  payment_method VARCHAR(100),
  merchant VARCHAR(255),
  budget_category VARCHAR(100),
  tags JSONB DEFAULT '[]',
  notes TEXT,
  receipt_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_finance_data_user_id ON finance_data(user_id);
CREATE INDEX idx_finance_data_transaction_date ON finance_data(transaction_date);
CREATE INDEX idx_finance_data_transaction_type ON finance_data(transaction_type);
CREATE INDEX idx_finance_data_category ON finance_data(category);
CREATE INDEX idx_finance_data_budget_category ON finance_data(budget_category);

-- ============================================================================
-- WEEKLY_SUMMARY TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  week_end_date DATE NOT NULL,
  week_number INTEGER,
  health_summary JSONB DEFAULT '{}',
  study_summary JSONB DEFAULT '{}',
  career_summary JSONB DEFAULT '{}',
  finance_summary JSONB DEFAULT '{}',
  notion_page_id VARCHAR(255),
  sync_status VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, week_start_date)
);

CREATE INDEX idx_weekly_summaries_user_id ON weekly_summaries(user_id);
CREATE INDEX idx_weekly_summaries_week_start_date ON weekly_summaries(week_start_date);

-- ============================================================================
-- AUDIT_LOG TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100),
  resource_id UUID,
  changes JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  status VARCHAR(50),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_resource_type ON audit_logs(resource_type);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- ============================================================================
-- VIEWS FOR ANALYTICS
-- ============================================================================

-- User engagement summary
CREATE OR REPLACE VIEW user_engagement AS
SELECT
  u.id as user_id,
  u.email,
  COUNT(DISTINCT e.id) as event_count,
  COUNT(DISTINCT e.session_id) as session_count,
  MAX(e.created_at) as last_active_at,
  s.status as subscription_status,
  s.plan as subscription_plan
FROM users u
LEFT JOIN events e ON u.id = e.user_id AND e.created_at > NOW() - INTERVAL '30 days'
LEFT JOIN subscriptions s ON u.id = s.user_id
GROUP BY u.id, u.email, s.status, s.plan;

-- Weekly metrics summary
CREATE OR REPLACE VIEW weekly_metrics AS
SELECT
  user_id,
  DATE_TRUNC('week', data_date)::DATE as week_start,
  SUM(steps) as total_steps,
  AVG(heart_rate_avg) as avg_heart_rate,
  SUM(sleep_minutes)::INTEGER / 60 as total_sleep_hours,
  COUNT(*) as days_tracked
FROM health_data
GROUP BY user_id, DATE_TRUNC('week', data_date);

-- Sync health report
CREATE OR REPLACE VIEW sync_health_report AS
SELECT
  user_id,
  sync_type,
  COUNT(*) as total_syncs,
  COUNT(CASE WHEN status = 'success' THEN 1 END) as successful_syncs,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_syncs,
  ROUND(100.0 * COUNT(CASE WHEN status = 'success' THEN 1 END) / COUNT(*), 2) as success_rate,
  AVG(duration_ms) as avg_duration_ms,
  MAX(completed_at) as last_sync_at
FROM sync_logs
WHERE created_at > NOW() - INTERVAL '90 days'
GROUP BY user_id, sync_type;

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply timestamp trigger to tables
CREATE TRIGGER users_update_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER connections_update_timestamp
BEFORE UPDATE ON connections
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER subscriptions_update_timestamp
BEFORE UPDATE ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER dashboards_update_timestamp
BEFORE UPDATE ON dashboards
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER health_data_update_timestamp
BEFORE UPDATE ON health_data
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER study_data_update_timestamp
BEFORE UPDATE ON study_data
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER career_data_update_timestamp
BEFORE UPDATE ON career_data
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER finance_data_update_timestamp
BEFORE UPDATE ON finance_data
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER weekly_summaries_update_timestamp
BEFORE UPDATE ON weekly_summaries
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Function to log user actions
CREATE OR REPLACE FUNCTION log_audit_event()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_logs (
    user_id,
    action,
    resource_type,
    resource_id,
    changes,
    status
  ) VALUES (
    COALESCE(NEW.user_id, OLD.user_id),
    TG_ARGV[0],
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)),
    'success'
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- GRANTS AND PERMISSIONS (optional - adjust as needed)
-- ============================================================================

-- Create application role
DO
$$
BEGIN
  CREATE ROLE app_user WITH LOGIN PASSWORD 'change_me_in_production';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

-- Grant permissions
GRANT CONNECT ON DATABASE postgres TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
