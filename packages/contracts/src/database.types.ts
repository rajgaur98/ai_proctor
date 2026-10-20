export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      activity_samples: {
        Row: {
          app_name: string;
          device_id: string;
          domain: string | null;
          id: string;
          minute: string;
          org_id: string;
          seconds: number;
          user_id: string;
          window_title: string | null;
        };
        ComputedFields: never;
        Insert: {
          app_name: string;
          device_id: string;
          domain?: string | null;
          id: string;
          minute: string;
          org_id: string;
          seconds: number;
          user_id: string;
          window_title?: string | null;
        };
        Update: {
          app_name?: string;
          device_id?: string;
          domain?: string | null;
          id?: string;
          minute?: string;
          org_id?: string;
          seconds?: number;
          user_id?: string;
          window_title?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "activity_samples_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activity_samples_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activity_samples_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "activity_samples_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_event_rejections: {
        Row: {
          device_id: string;
          event_id: string | null;
          reason: string;
          received_at: string;
          seq: number | null;
          type: string | null;
        };
        ComputedFields: never;
        Insert: {
          device_id: string;
          event_id?: string | null;
          reason: string;
          received_at?: string;
          seq?: number | null;
          type?: string | null;
        };
        Update: {
          device_id?: string;
          event_id?: string | null;
          reason?: string;
          received_at?: string;
          seq?: number | null;
          type?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "agent_event_rejections_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_events_raw: {
        Row: {
          at: string;
          device_id: string;
          id: string;
          org_id: string;
          payload: NonNullable<Json>;
          received_at: string;
          seq: number;
          type: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          at: string;
          device_id: string;
          id: string;
          org_id: string;
          payload?: NonNullable<Json>;
          received_at?: string;
          seq: number;
          type: string;
          user_id: string;
        };
        Update: {
          at?: string;
          device_id?: string;
          id?: string;
          org_id?: string;
          payload?: NonNullable<Json>;
          received_at?: string;
          seq?: number;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_events_raw_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_events_raw_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_events_raw_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "agent_events_raw_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      alerts: {
        Row: {
          details: NonNullable<Json>;
          email_id: string | null;
          episode: string;
          id: string;
          kind: Database["public"]["Enums"]["alert_kind"];
          org_id: string;
          read_at: string | null;
          recipient_id: string;
          triggered_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          details?: NonNullable<Json>;
          email_id?: string | null;
          episode: string;
          id?: string;
          kind: Database["public"]["Enums"]["alert_kind"];
          org_id: string;
          read_at?: string | null;
          recipient_id: string;
          triggered_at?: string;
          user_id: string;
        };
        Update: {
          details?: NonNullable<Json>;
          email_id?: string | null;
          episode?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["alert_kind"];
          org_id?: string;
          read_at?: string | null;
          recipient_id?: string;
          triggered_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "alerts_email_id_fkey";
            columns: ["email_id"];
            isOneToOne: false;
            referencedRelation: "email_outbox";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "alerts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "alerts_recipient_id_fkey";
            columns: ["recipient_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "alerts_recipient_id_fkey";
            columns: ["recipient_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "alerts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "alerts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      anticheat_flags: {
        Row: {
          created_at: string;
          day: string;
          details: NonNullable<Json>;
          id: string;
          kind: Database["public"]["Enums"]["anticheat_kind"];
          org_id: string;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          day: string;
          details?: NonNullable<Json>;
          id?: string;
          kind: Database["public"]["Enums"]["anticheat_kind"];
          org_id: string;
          review_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          day?: string;
          details?: NonNullable<Json>;
          id?: string;
          kind?: Database["public"]["Enums"]["anticheat_kind"];
          org_id?: string;
          review_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "anticheat_flags_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "anticheat_flags_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "anticheat_flags_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "anticheat_flags_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "anticheat_flags_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_log: {
        Row: {
          action: string;
          actor_id: string | null;
          actor_name: string | null;
          at: string;
          id: number;
          metadata: NonNullable<Json>;
          org_id: string;
          target_name: string | null;
          target_user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_id?: string | null;
          actor_name?: string | null;
          at?: string;
          id?: never;
          metadata?: NonNullable<Json>;
          org_id: string;
          target_name?: string | null;
          target_user_id?: string | null;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          actor_name?: string | null;
          at?: string;
          id?: never;
          metadata?: NonNullable<Json>;
          org_id?: string;
          target_name?: string | null;
          target_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      breaks: {
        Row: {
          clock_session_id: string;
          end_at: string | null;
          id: string;
          org_id: string;
          over_cap_s: number;
          planned_min: number | null;
          start_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          clock_session_id: string;
          end_at?: string | null;
          id?: string;
          org_id: string;
          over_cap_s?: number;
          planned_min?: number | null;
          start_at: string;
          user_id: string;
        };
        Update: {
          clock_session_id?: string;
          end_at?: string | null;
          id?: string;
          org_id?: string;
          over_cap_s?: number;
          planned_min?: number | null;
          start_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "breaks_clock_session_id_fkey";
            columns: ["clock_session_id"];
            isOneToOne: false;
            referencedRelation: "clock_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "breaks_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "breaks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "breaks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      checkin_events: {
        Row: {
          capture_errors: Json | null;
          captures_purged_at: string | null;
          created_at: string;
          deferral_reason: string | null;
          device_id: string;
          device_state: string | null;
          face_present: boolean | null;
          flags: string[];
          id: string;
          idle_s_at_show: number | null;
          missed_reason: string | null;
          missed_reason_kind: string | null;
          object_keys: string[];
          org_id: string;
          outcome: Database["public"]["Enums"]["checkin_outcome"];
          project_id: string | null;
          responded_at: string | null;
          response_ms: number | null;
          scheduled_at: string;
          shown_at: string | null;
          user_id: string;
          wrong_clicks: number;
        };
        ComputedFields: never;
        Insert: {
          capture_errors?: Json | null;
          captures_purged_at?: string | null;
          created_at?: string;
          deferral_reason?: string | null;
          device_id: string;
          device_state?: string | null;
          face_present?: boolean | null;
          flags?: string[];
          id: string;
          idle_s_at_show?: number | null;
          missed_reason?: string | null;
          missed_reason_kind?: string | null;
          object_keys?: string[];
          org_id: string;
          outcome: Database["public"]["Enums"]["checkin_outcome"];
          project_id?: string | null;
          responded_at?: string | null;
          response_ms?: number | null;
          scheduled_at: string;
          shown_at?: string | null;
          user_id: string;
          wrong_clicks?: number;
        };
        Update: {
          capture_errors?: Json | null;
          captures_purged_at?: string | null;
          created_at?: string;
          deferral_reason?: string | null;
          device_id?: string;
          device_state?: string | null;
          face_present?: boolean | null;
          flags?: string[];
          id?: string;
          idle_s_at_show?: number | null;
          missed_reason?: string | null;
          missed_reason_kind?: string | null;
          object_keys?: string[];
          org_id?: string;
          outcome?: Database["public"]["Enums"]["checkin_outcome"];
          project_id?: string | null;
          responded_at?: string | null;
          response_ms?: number | null;
          scheduled_at?: string;
          shown_at?: string | null;
          user_id?: string;
          wrong_clicks?: number;
        };
        Relationships: [
          {
            foreignKeyName: "checkin_events_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "checkin_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "checkin_events_project_fk";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "checkin_events_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "checkin_events_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      clients: {
        Row: {
          archived: boolean;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          archived?: boolean;
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
        };
        Update: {
          archived?: boolean;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "clients_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      clock_sessions: {
        Row: {
          device_id: string;
          end_at: string | null;
          end_event_id: string | null;
          end_reason: string | null;
          id: string;
          org_id: string;
          project_id: string | null;
          start_at: string;
          start_event_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          device_id: string;
          end_at?: string | null;
          end_event_id?: string | null;
          end_reason?: string | null;
          id?: string;
          org_id: string;
          project_id?: string | null;
          start_at: string;
          start_event_id: string;
          user_id: string;
        };
        Update: {
          device_id?: string;
          end_at?: string | null;
          end_event_id?: string | null;
          end_reason?: string | null;
          id?: string;
          org_id?: string;
          project_id?: string | null;
          start_at?: string;
          start_event_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "clock_sessions_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clock_sessions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clock_sessions_project_fk";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clock_sessions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "clock_sessions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      delegations: {
        Row: {
          created_at: string;
          created_by: string | null;
          delegate_id: string;
          end_reason: string | null;
          ended_at: string | null;
          ends_on: string;
          id: string;
          manager_id: string;
          org_id: string;
          starts_on: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          delegate_id: string;
          end_reason?: string | null;
          ended_at?: string | null;
          ends_on: string;
          id?: string;
          manager_id: string;
          org_id: string;
          starts_on: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          delegate_id?: string;
          end_reason?: string | null;
          ended_at?: string | null;
          ends_on?: string;
          id?: string;
          manager_id?: string;
          org_id?: string;
          starts_on?: string;
        };
        Relationships: [
          {
            foreignKeyName: "delegations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "delegations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "delegations_delegate_id_fkey";
            columns: ["delegate_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "delegations_delegate_id_fkey";
            columns: ["delegate_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "delegations_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "delegations_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "delegations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      device_sessions: {
        Row: {
          created_at: string;
          device_id: string;
          org_id: string;
          session_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          device_id: string;
          org_id: string;
          session_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          device_id?: string;
          org_id?: string;
          session_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "device_sessions_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_sessions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_sessions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "device_sessions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      devices: {
        Row: {
          acked_seq: number;
          agent_version: string;
          created_at: string;
          hardware_hash: string;
          id: string;
          org_id: string;
          os_version: string;
          platform: Database["public"]["Enums"]["device_platform"];
          revoked_at: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          acked_seq?: number;
          agent_version: string;
          created_at?: string;
          hardware_hash: string;
          id?: string;
          org_id: string;
          os_version: string;
          platform: Database["public"]["Enums"]["device_platform"];
          revoked_at?: string | null;
          user_id: string;
        };
        Update: {
          acked_seq?: number;
          agent_version?: string;
          created_at?: string;
          hardware_hash?: string;
          id?: string;
          org_id?: string;
          os_version?: string;
          platform?: Database["public"]["Enums"]["device_platform"];
          revoked_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "devices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "devices_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "devices_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      dirty_days: {
        Row: {
          attempts: number;
          day: string;
          last_error: string | null;
          marked_at: string;
          next_attempt_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          day: string;
          last_error?: string | null;
          marked_at?: string;
          next_attempt_at?: string;
          user_id: string;
        };
        Update: {
          attempts?: number;
          day?: string;
          last_error?: string | null;
          marked_at?: string;
          next_attempt_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "dirty_days_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "dirty_days_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      email_outbox: {
        Row: {
          attempts: number;
          batch_key: string | null;
          created_at: string;
          id: string;
          last_error: string | null;
          org_id: string;
          payload: NonNullable<Json>;
          send_after: string;
          sent_at: string | null;
          template: string;
          to_email: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          batch_key?: string | null;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          org_id: string;
          payload?: NonNullable<Json>;
          send_after?: string;
          sent_at?: string | null;
          template: string;
          to_email: string;
        };
        Update: {
          attempts?: number;
          batch_key?: string | null;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          org_id?: string;
          payload?: NonNullable<Json>;
          send_after?: string;
          sent_at?: string | null;
          template?: string;
          to_email?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_outbox_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      last_seen: {
        Row: {
          at: string;
          device_id: string;
          org_id: string;
          state: NonNullable<Json>;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          at: string;
          device_id: string;
          org_id: string;
          state?: NonNullable<Json>;
          user_id: string;
        };
        Update: {
          at?: string;
          device_id?: string;
          org_id?: string;
          state?: NonNullable<Json>;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "last_seen_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "last_seen_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "last_seen_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "last_seen_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      manual_entries: {
        Row: {
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_note: string | null;
          end_at: string;
          id: string;
          org_id: string;
          project_id: string | null;
          reason: string;
          start_at: string;
          status: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          end_at: string;
          id?: string;
          org_id: string;
          project_id?: string | null;
          reason: string;
          start_at: string;
          status?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          end_at?: string;
          id?: string;
          org_id?: string;
          project_id?: string | null;
          reason?: string;
          start_at?: string;
          status?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "manual_entries_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "manual_entries_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "manual_entries_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "manual_entries_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "manual_entries_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "manual_entries_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      notice_acks: {
        Row: {
          acknowledged_at: string;
          notice_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          acknowledged_at?: string;
          notice_id: string;
          user_id: string;
        };
        Update: {
          acknowledged_at?: string;
          notice_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notice_acks_notice_id_fkey";
            columns: ["notice_id"];
            isOneToOne: false;
            referencedRelation: "notices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notice_acks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "notice_acks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      notices: {
        Row: {
          body: NonNullable<Json>;
          collection: NonNullable<Json>;
          id: string;
          org_id: string;
          published_at: string;
          published_by: string | null;
          region: Database["public"]["Enums"]["region_preset"];
          version: number;
        };
        ComputedFields: never;
        Insert: {
          body: NonNullable<Json>;
          collection: NonNullable<Json>;
          id?: string;
          org_id: string;
          published_at?: string;
          published_by?: string | null;
          region: Database["public"]["Enums"]["region_preset"];
          version: number;
        };
        Update: {
          body?: NonNullable<Json>;
          collection?: NonNullable<Json>;
          id?: string;
          org_id?: string;
          published_at?: string;
          published_by?: string | null;
          region?: Database["public"]["Enums"]["region_preset"];
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "notices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notices_published_by_fkey";
            columns: ["published_by"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "notices_published_by_fkey";
            columns: ["published_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          org_id: string;
          payload: NonNullable<Json>;
          read_at: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          kind: string;
          org_id: string;
          payload?: NonNullable<Json>;
          read_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          org_id?: string;
          payload?: NonNullable<Json>;
          read_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      orgs: {
        Row: {
          created_at: string;
          data_region: Database["public"]["Enums"]["data_region"];
          id: string;
          name: string;
          policy: NonNullable<Json>;
          policy_version: number;
          region_preset: Database["public"]["Enums"]["region_preset"];
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          data_region?: Database["public"]["Enums"]["data_region"];
          id?: string;
          name: string;
          policy?: NonNullable<Json>;
          policy_version?: number;
          region_preset?: Database["public"]["Enums"]["region_preset"];
        };
        Update: {
          created_at?: string;
          data_region?: Database["public"]["Enums"]["data_region"];
          id?: string;
          name?: string;
          policy?: NonNullable<Json>;
          policy_version?: number;
          region_preset?: Database["public"]["Enums"]["region_preset"];
        };
        Relationships: [];
      };
      pauses: {
        Row: {
          clock_session_id: string;
          end_at: string | null;
          id: string;
          org_id: string;
          over_cap_s: number;
          planned_min: number;
          private_reason: string | null;
          start_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          clock_session_id: string;
          end_at?: string | null;
          id?: string;
          org_id: string;
          over_cap_s?: number;
          planned_min: number;
          private_reason?: string | null;
          start_at: string;
          user_id: string;
        };
        Update: {
          clock_session_id?: string;
          end_at?: string | null;
          id?: string;
          org_id?: string;
          over_cap_s?: number;
          planned_min?: number;
          private_reason?: string | null;
          start_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pauses_clock_session_id_fkey";
            columns: ["clock_session_id"];
            isOneToOne: false;
            referencedRelation: "clock_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pauses_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pauses_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "pauses_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      presence: {
        Row: {
          call_sources: string[];
          camera_permission: string | null;
          idle: boolean;
          last_checkin_at: string | null;
          last_checkin_outcome: Database["public"]["Enums"]["checkin_outcome"] | null;
          last_contact_at: string | null;
          locked: boolean;
          org_id: string;
          project_id: string | null;
          screen_permission: string | null;
          since: string;
          status: Database["public"]["Enums"]["presence_status"];
          tamper_reason: Database["public"]["Enums"]["tamper_reason"] | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          call_sources?: string[];
          camera_permission?: string | null;
          idle?: boolean;
          last_checkin_at?: string | null;
          last_checkin_outcome?: Database["public"]["Enums"]["checkin_outcome"] | null;
          last_contact_at?: string | null;
          locked?: boolean;
          org_id: string;
          project_id?: string | null;
          screen_permission?: string | null;
          since?: string;
          status?: Database["public"]["Enums"]["presence_status"];
          tamper_reason?: Database["public"]["Enums"]["tamper_reason"] | null;
          user_id: string;
        };
        Update: {
          call_sources?: string[];
          camera_permission?: string | null;
          idle?: boolean;
          last_checkin_at?: string | null;
          last_checkin_outcome?: Database["public"]["Enums"]["checkin_outcome"] | null;
          last_contact_at?: string | null;
          locked?: boolean;
          org_id?: string;
          project_id?: string | null;
          screen_permission?: string | null;
          since?: string;
          status?: Database["public"]["Enums"]["presence_status"];
          tamper_reason?: Database["public"]["Enums"]["tamper_reason"] | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "presence_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "presence_project_fk";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "presence_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "presence_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      project_members: {
        Row: {
          org_id: string;
          project_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          org_id: string;
          project_id: string;
          user_id: string;
        };
        Update: {
          org_id?: string;
          project_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_members_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_members_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "project_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          archived: boolean;
          billable: boolean;
          client_id: string | null;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          archived?: boolean;
          billable?: boolean;
          client_id?: string | null;
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
        };
        Update: {
          archived?: boolean;
          billable?: boolean;
          client_id?: string | null;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      reminders_sent: {
        Row: {
          episode: string;
          id: string;
          kind: string;
          org_id: string;
          period_start: string;
          recipient_id: string;
          sent_at: string;
          timesheet_id: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          episode?: string;
          id?: string;
          kind: string;
          org_id: string;
          period_start: string;
          recipient_id: string;
          sent_at?: string;
          timesheet_id?: string | null;
          user_id: string;
        };
        Update: {
          episode?: string;
          id?: string;
          kind?: string;
          org_id?: string;
          period_start?: string;
          recipient_id?: string;
          sent_at?: string;
          timesheet_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reminders_sent_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reminders_sent_recipient_id_fkey";
            columns: ["recipient_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "reminders_sent_recipient_id_fkey";
            columns: ["recipient_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reminders_sent_timesheet_id_fkey";
            columns: ["timesheet_id"];
            isOneToOne: false;
            referencedRelation: "timesheets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reminders_sent_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "reminders_sent_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      retention_runs: {
        Row: {
          at: string;
          category: string;
          deleted: number;
          id: number;
          org_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          category: string;
          deleted: number;
          id?: never;
          org_id?: string | null;
        };
        Update: {
          at?: string;
          category?: string;
          deleted?: number;
          id?: never;
          org_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "retention_runs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      shifts: {
        Row: {
          created_at: string;
          days: number[];
          end_time: string;
          id: string;
          org_id: string;
          start_time: string;
          timezone: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          days: number[];
          end_time: string;
          id?: string;
          org_id: string;
          start_time: string;
          timezone: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          days?: number[];
          end_time?: string;
          id?: string;
          org_id?: string;
          start_time?: string;
          timezone?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shifts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shifts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "shifts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      status_periods: {
        Row: {
          end_at: string | null;
          id: string;
          org_id: string;
          reason: Database["public"]["Enums"]["tamper_reason"] | null;
          start_at: string;
          status: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          end_at?: string | null;
          id?: string;
          org_id: string;
          reason?: Database["public"]["Enums"]["tamper_reason"] | null;
          start_at: string;
          status: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        Update: {
          end_at?: string | null;
          id?: string;
          org_id?: string;
          reason?: Database["public"]["Enums"]["tamper_reason"] | null;
          start_at?: string;
          status?: Database["public"]["Enums"]["presence_status"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "status_periods_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "status_periods_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "status_periods_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      time_segments: {
        Row: {
          counted: boolean;
          day: string;
          end_at: string;
          excluded: boolean;
          excluded_by: string | null;
          excluded_reason: string | null;
          flagged: boolean;
          id: string;
          org_id: string;
          project_id: string | null;
          source: string;
          start_at: string;
          type: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          counted: boolean;
          day: string;
          end_at: string;
          excluded?: boolean;
          excluded_by?: string | null;
          excluded_reason?: string | null;
          flagged: boolean;
          id?: string;
          org_id: string;
          project_id?: string | null;
          source?: string;
          start_at: string;
          type: string;
          user_id: string;
        };
        Update: {
          counted?: boolean;
          day?: string;
          end_at?: string;
          excluded?: boolean;
          excluded_by?: string | null;
          excluded_reason?: string | null;
          flagged?: boolean;
          id?: string;
          org_id?: string;
          project_id?: string | null;
          source?: string;
          start_at?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "time_segments_excluded_by_fkey";
            columns: ["excluded_by"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "time_segments_excluded_by_fkey";
            columns: ["excluded_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_segments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_segments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "time_segments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      timesheet_edits: {
        Row: {
          created_at: string;
          detail: NonNullable<Json>;
          editor_id: string | null;
          end_at: string;
          id: string;
          kind: string;
          org_id: string;
          project_id: string | null;
          reason: string | null;
          seq: number;
          start_at: string;
          timesheet_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          detail?: NonNullable<Json>;
          editor_id?: string | null;
          end_at: string;
          id?: string;
          kind: string;
          org_id: string;
          project_id?: string | null;
          reason?: string | null;
          seq?: never;
          start_at: string;
          timesheet_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          detail?: NonNullable<Json>;
          editor_id?: string | null;
          end_at?: string;
          id?: string;
          kind?: string;
          org_id?: string;
          project_id?: string | null;
          reason?: string | null;
          seq?: never;
          start_at?: string;
          timesheet_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "timesheet_edits_editor_id_fkey";
            columns: ["editor_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "timesheet_edits_editor_id_fkey";
            columns: ["editor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timesheet_edits_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timesheet_edits_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timesheet_edits_timesheet_id_fkey";
            columns: ["timesheet_id"];
            isOneToOne: false;
            referencedRelation: "timesheets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timesheet_edits_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "timesheet_edits_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      timesheets: {
        Row: {
          approved_at: string | null;
          approver_id: string | null;
          comment: string | null;
          created_at: string;
          id: string;
          late_data_at: string | null;
          late_data_count: number;
          late_data_last_at: string | null;
          org_id: string;
          period_start: string;
          returned_at: string | null;
          status: string;
          submitted_at: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          approved_at?: string | null;
          approver_id?: string | null;
          comment?: string | null;
          created_at?: string;
          id?: string;
          late_data_at?: string | null;
          late_data_count?: number;
          late_data_last_at?: string | null;
          org_id: string;
          period_start: string;
          returned_at?: string | null;
          status?: string;
          submitted_at?: string | null;
          user_id: string;
        };
        Update: {
          approved_at?: string | null;
          approver_id?: string | null;
          comment?: string | null;
          created_at?: string;
          id?: string;
          late_data_at?: string | null;
          late_data_count?: number;
          late_data_last_at?: string | null;
          org_id?: string;
          period_start?: string;
          returned_at?: string | null;
          status?: string;
          submitted_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "timesheets_approver_id_fkey";
            columns: ["approver_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "timesheets_approver_id_fkey";
            columns: ["approver_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timesheets_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timesheets_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "timesheets_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      users: {
        Row: {
          active: boolean;
          approval_required: boolean;
          config_version: number;
          created_at: string;
          email: string;
          full_name: string;
          id: string;
          manager_id: string | null;
          org_id: string;
          role: Database["public"]["Enums"]["user_role"];
          timezone: string;
          work_country: string;
          work_state: string | null;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          approval_required?: boolean;
          config_version?: number;
          created_at?: string;
          email: string;
          full_name: string;
          id: string;
          manager_id?: string | null;
          org_id: string;
          role?: Database["public"]["Enums"]["user_role"];
          timezone?: string;
          work_country?: string;
          work_state?: string | null;
        };
        Update: {
          active?: boolean;
          approval_required?: boolean;
          config_version?: number;
          created_at?: string;
          email?: string;
          full_name?: string;
          id?: string;
          manager_id?: string | null;
          org_id?: string;
          role?: Database["public"]["Enums"]["user_role"];
          timezone?: string;
          work_country?: string;
          work_state?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "users_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "users_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "users_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      my_pauses: {
        Row: {
          clock_session_id: string | null;
          end_at: string | null;
          id: string | null;
          org_id: string | null;
          over_cap_s: number | null;
          planned_min: number | null;
          private_reason: string | null;
          start_at: string | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          clock_session_id?: string | null;
          end_at?: string | null;
          id?: string | null;
          org_id?: string | null;
          over_cap_s?: number | null;
          planned_min?: number | null;
          private_reason?: string | null;
          start_at?: string | null;
          user_id?: string | null;
        };
        Update: {
          clock_session_id?: string | null;
          end_at?: string | null;
          id?: string | null;
          org_id?: string | null;
          over_cap_s?: number | null;
          planned_min?: number | null;
          private_reason?: string | null;
          start_at?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "pauses_clock_session_id_fkey";
            columns: ["clock_session_id"];
            isOneToOne: false;
            referencedRelation: "clock_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pauses_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pauses_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "pauses_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      team_live: {
        Row: {
          checkins_passed_today: number | null;
          checkins_shown_today: number | null;
          full_name: string | null;
          last_checkin_at: string | null;
          last_checkin_outcome: Database["public"]["Enums"]["checkin_outcome"] | null;
          manager_id: string | null;
          org_id: string | null;
          project_id: string | null;
          role: Database["public"]["Enums"]["user_role"] | null;
          scheduled_today: boolean | null;
          since: string | null;
          status: Database["public"]["Enums"]["presence_status"] | null;
          tamper_reason: Database["public"]["Enums"]["tamper_reason"] | null;
          timezone: string | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "presence_project_fk";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "users_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "team_live";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "users_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "users_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      acknowledge_notice: { Args: { p_notice_id: string }; Returns: undefined };
      activity_summary: {
        Args: { p_from: string; p_to: string; p_user_id: string };
        Returns: {
          app_name: string;
          domain: string;
          seconds: number;
          titles: string[];
        }[];
      };
      add_invited_member: {
        Args: {
          p_email: string;
          p_full_name: string;
          p_inviter_id: string;
          p_manager_id: string;
          p_role: Database["public"]["Enums"]["user_role"];
          p_timezone: string;
          p_user_id: string;
          p_work_country: string;
          p_work_state: string;
        };
        Returns: undefined;
      };
      adjust_time: {
        Args: {
          p_end_at: string;
          p_entry_id?: string;
          p_project_id: string;
          p_reason: string;
          p_start_at: string;
          p_timesheet_id: string;
        };
        Returns: string;
      };
      agent_config: { Args: { p_device_id: string }; Returns: Json };
      agent_events: { Args: { device_id: string; events: Json }; Returns: Json };
      agent_heartbeat: {
        Args: {
          agent_version: string;
          device_id: string;
          idle_s: number;
          in_call: boolean;
          locked: boolean;
          permissions: Json;
          sent_at: string;
        };
        Returns: Json;
      };
      anticheat_mark_reviewed: { Args: { p_flag_id: string; p_note?: string }; Returns: undefined };
      approve_timesheet: { Args: { p_id: string }; Returns: undefined };
      begin_user_data_request: {
        Args: { p_action: string; p_email: string; p_user_id: string };
        Returns: Json;
      };
      can_approve_for: { Args: { target: string }; Returns: boolean };
      can_decide_timesheet: { Args: { target: string }; Returns: boolean };
      can_reopen_timesheet: { Args: { target: string }; Returns: boolean };
      can_view_user: { Args: { target: string }; Returns: boolean };
      cancel_manual_entry: { Args: { p_id: string }; Returns: undefined };
      capture_view: { Args: { p_checkin_id: string }; Returns: Json };
      create_org: {
        Args: {
          full_name?: string;
          org_name: string;
          region_preset?: Database["public"]["Enums"]["region_preset"];
          timezone?: string;
        };
        Returns: string;
      };
      decide_manual_entry: {
        Args: { p_approve: boolean; p_id: string; p_note?: string };
        Returns: undefined;
      };
      delegate_candidates: {
        Args: { p_manager_id?: string };
        Returns: {
          full_name: string;
          id: string;
          role: Database["public"]["Enums"]["user_role"];
        }[];
      };
      delegation_history: {
        Args: { p_manager_id?: string };
        Returns: {
          delegate_id: string;
          delegate_name: string;
          end_reason: string;
          ended_at: string;
          ends_on: string;
          id: string;
          manager_id: string;
          manager_name: string;
          starts_on: string;
          status: string;
        }[];
      };
      delete_user_data: { Args: { p_email: string; p_user_id: string }; Returns: Json };
      due_segment_days: {
        Args: { p_limit?: number };
        Returns: {
          day: string;
          picked_at: string;
          user_id: string;
        }[];
      };
      edit_segment: {
        Args: {
          p_end_at: string;
          p_kind: string;
          p_project_id?: string;
          p_reason?: string;
          p_start_at: string;
          p_timesheet_id: string;
        };
        Returns: string;
      };
      email_claim: {
        Args: { p_limit?: number };
        Returns: {
          attempts: number;
          batch_key: string | null;
          created_at: string;
          id: string;
          last_error: string | null;
          org_id: string;
          payload: NonNullable<Json>;
          send_after: string;
          sent_at: string | null;
          template: string;
          to_email: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "email_outbox";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      email_mark_failed: { Args: { p_error: string; p_id: string }; Returns: undefined };
      email_mark_sent: { Args: { p_id: string }; Returns: undefined };
      end_delegation: { Args: { p_id: string }; Returns: undefined };
      ensure_timesheet: { Args: { p_period_start: string; p_user_id: string }; Returns: string };
      export_audit_log: {
        Args: {
          p_actions?: string[];
          p_actor_id?: string;
          p_from?: string;
          p_target_user_id?: string;
          p_to?: string;
        };
        Returns: Json;
      };
      export_capture_objects: {
        Args: { p_paths: string[]; p_user_id: string };
        Returns: {
          bytes: number;
          name: string;
        }[];
      };
      export_user_capture_views: {
        Args: { p_days?: number; p_user_id: string };
        Returns: {
          checkin_at: string;
          checkin_id: string;
          viewed_at: string;
          viewer_id: string;
          viewer_name: string;
          viewer_role: string;
        }[];
      };
      list_user_capture_objects: {
        Args: { p_limit?: number; p_user_id: string };
        Returns: {
          name: string;
        }[];
      };
      mark_alerts_read: { Args: { p_ids?: string[] }; Returns: number };
      mark_alerts_read_matching: {
        Args: {
          p_from?: string;
          p_kind?: Database["public"]["Enums"]["alert_kind"];
          p_to?: string;
          p_user_id?: string;
        };
        Returns: number;
      };
      mark_notifications_read: { Args: { p_ids?: string[] }; Returns: number };
      my_capture_views: {
        Args: { p_days?: number };
        Returns: {
          checkin_at: string;
          checkin_id: string;
          viewed_at: string;
          viewer_id: string;
          viewer_name: string;
          viewer_role: string;
        }[];
      };
      my_delegations: {
        Args: Record<PropertyKey, never>;
        Returns: {
          delegate_id: string;
          delegate_name: string;
          ends_on: string;
          id: string;
          manager_id: string;
          manager_name: string;
          starts_on: string;
        }[];
      };
      my_edit_history: {
        Args: { p_limit?: number };
        Returns: {
          created_at: string;
          editor_id: string;
          editor_name: string;
          end_at: string;
          id: string;
          kind: string;
          period_start: string;
          project_id: string;
          reason: string;
          start_at: string;
        }[];
      };
      my_manager: {
        Args: Record<PropertyKey, never>;
        Returns: {
          full_name: string;
          id: string;
        }[];
      };
      notice_template: { Args: Record<PropertyKey, never>; Returns: Json };
      policy_settings: { Args: Record<PropertyKey, never>; Returns: Json };
      publish_notice: { Args: { p_body: Json }; Returns: number };
      reassign_my_time: {
        Args: { p_end: string; p_project_id: string; p_reason?: string; p_start: string };
        Returns: string;
      };
      record_my_data_export: { Args: { p_counts: Json; p_user_id: string }; Returns: undefined };
      record_segment_failure: {
        Args: { p_day: string; p_error: string; p_started_at?: string; p_user_id: string };
        Returns: undefined;
      };
      record_user_data_export: {
        Args: { p_actor_id: string; p_counts: Json; p_user_id: string };
        Returns: undefined;
      };
      register_device: {
        Args: {
          agent_version: string;
          hardware_hash: string;
          os_version: string;
          platform: Database["public"]["Enums"]["device_platform"];
        };
        Returns: Record<string, unknown>;
      };
      reopen_timesheet: { Args: { p_id: string; p_reason: string }; Returns: undefined };
      replace_day_segments: {
        Args: { p_day: string; p_loaded_at?: string; p_segments: Json; p_user_id: string };
        Returns: number;
      };
      report_rows: {
        Args: { p_from: string; p_manager_id?: string; p_to: string; p_user_ids?: string[] };
        Returns: Json;
      };
      request_manual_entry: {
        Args: { p_end_at: string; p_project_id: string; p_reason: string; p_start_at: string };
        Returns: string;
      };
      retention_expired_captures: {
        Args: { p_limit?: number };
        Returns: {
          checkin_id: string;
          paths: string[];
        }[];
      };
      retention_mark_captures_purged: { Args: { p_checkin_ids: string[] }; Returns: number };
      retention_purge_rows: { Args: Record<PropertyKey, never>; Returns: Json };
      return_timesheet: { Args: { p_comment: string; p_id: string }; Returns: undefined };
      revoke_device: { Args: { p_device_id: string }; Returns: undefined };
      save_client: {
        Args: { p_archived?: boolean; p_id: string; p_name: string };
        Returns: string;
      };
      save_project: {
        Args: {
          p_archived?: boolean;
          p_billable?: boolean;
          p_client_id?: string;
          p_id: string;
          p_name: string;
        };
        Returns: string;
      };
      search_audit_log: {
        Args: {
          p_actions?: string[];
          p_actor_id?: string;
          p_cursor_at?: string;
          p_cursor_id?: number;
          p_from?: string;
          p_limit?: number;
          p_target_user_id?: string;
          p_to?: string;
        };
        Returns: {
          action: string;
          actor_id: string;
          actor_name: string;
          at: string;
          id: number;
          metadata: Json;
          target_name: string;
          target_user_id: string;
        }[];
      };
      segment_inputs: { Args: { p_day: string; p_user_id: string }; Returns: Json };
      set_approval_required: {
        Args: { p_required: boolean; p_user_id: string };
        Returns: undefined;
      };
      set_delegation: {
        Args: {
          p_delegate_id: string;
          p_ends_on: string;
          p_manager_id?: string;
          p_starts_on: string;
        };
        Returns: string;
      };
      set_miss_reason: {
        Args: { p_checkin_id: string; p_kind: string; p_note?: string };
        Returns: undefined;
      };
      set_project_members: {
        Args: { p_project_id: string; p_user_ids: string[] };
        Returns: undefined;
      };
      set_shifts: { Args: { p_shifts: Json; p_user_id: string }; Returns: undefined };
      set_user_active: { Args: { p_active: boolean; p_user_id: string }; Returns: undefined };
      stuck_segment_days: {
        Args: Record<PropertyKey, never>;
        Returns: {
          attempts: number;
          day: string;
          email: string;
          full_name: string;
          last_error: string;
          marked_at: string;
          next_attempt_at: string;
          user_id: string;
        }[];
      };
      submit_timesheet: { Args: { p_id: string }; Returns: string };
      timesheet_breakdown: {
        Args: { p_from: string; p_to: string; p_user_id: string };
        Returns: {
          counted: boolean;
          day: string;
          excluded: boolean;
          flagged: boolean;
          project_id: string;
          seconds: number;
          type: string;
        }[];
      };
      timesheet_export_rows: {
        Args: {
          p_client_ids?: string[];
          p_from: string;
          p_manager_id?: string;
          p_project_ids?: string[];
          p_statuses?: string[];
          p_to: string;
          p_user_ids?: string[];
          p_view: string;
        };
        Returns: Json;
      };
      timesheet_flagged_segments: {
        Args: { p_from: string; p_to: string; p_user_id: string };
        Returns: {
          day: string;
          decision: string;
          end_at: string;
          excluded: boolean;
          excluded_reason: string;
          id: string;
          project_id: string;
          start_at: string;
          type: string;
        }[];
      };
      timesheet_totals: {
        Args: { p_from: string; p_to: string };
        Returns: {
          excluded_s: number;
          flagged_s: number;
          user_id: string;
          worked_s: number;
        }[];
      };
      update_member: {
        Args: {
          p_full_name: string;
          p_manager_id: string;
          p_role: Database["public"]["Enums"]["user_role"];
          p_timezone: string;
          p_user_id: string;
          p_work_country: string;
          p_work_state: string;
        };
        Returns: undefined;
      };
      update_policy: {
        Args: { p_dpia_confirmed?: boolean; p_policy: Json; p_works_council_confirmed?: boolean };
        Returns: Json;
      };
    };
    Enums: {
      alert_kind: "consecutive_misses" | "offline" | "tamper" | "late_clock_in" | "pause_over_cap";
      anticheat_kind: "injected_click" | "fast_response" | "low_variance";
      checkin_outcome: "pass" | "miss" | "failed" | "deferred";
      data_region: "us" | "eu";
      device_platform: "macos" | "windows";
      presence_status:
        | "off_shift"
        | "tamper"
        | "offline"
        | "on_break"
        | "paused"
        | "away_locked"
        | "away"
        | "in_meeting"
        | "idle"
        | "active";
      region_preset: "us" | "eu" | "india";
      tamper_reason: "capture_blocked" | "agent_stopped" | "no_heartbeat";
      user_role: "owner" | "admin" | "manager" | "employee";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      alert_kind: ["consecutive_misses", "offline", "tamper", "late_clock_in", "pause_over_cap"],
      anticheat_kind: ["injected_click", "fast_response", "low_variance"],
      checkin_outcome: ["pass", "miss", "failed", "deferred"],
      data_region: ["us", "eu"],
      device_platform: ["macos", "windows"],
      presence_status: [
        "off_shift",
        "tamper",
        "offline",
        "on_break",
        "paused",
        "away_locked",
        "away",
        "in_meeting",
        "idle",
        "active",
      ],
      region_preset: ["us", "eu", "india"],
      tamper_reason: ["capture_blocked", "agent_stopped", "no_heartbeat"],
      user_role: ["owner", "admin", "manager", "employee"],
    },
  },
} as const;
