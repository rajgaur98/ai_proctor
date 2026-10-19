export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
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
      breaks: {
        Row: {
          clock_session_id: string;
          end_at: string | null;
          id: string;
          org_id: string;
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
          planned_min?: number | null;
          start_at: string;
          user_id: string;
        };
        Update: {
          clock_session_id?: string;
          end_at?: string | null;
          id?: string;
          org_id?: string;
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
          created_at: string;
          device_id: string;
          device_state: string | null;
          face_present: boolean | null;
          flags: string[];
          id: string;
          idle_s_at_show: number | null;
          missed_reason: string | null;
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
          created_at?: string;
          device_id: string;
          device_state?: string | null;
          face_present?: boolean | null;
          flags?: string[];
          id: string;
          idle_s_at_show?: number | null;
          missed_reason?: string | null;
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
          created_at?: string;
          device_id?: string;
          device_state?: string | null;
          face_present?: boolean | null;
          flags?: string[];
          id?: string;
          idle_s_at_show?: number | null;
          missed_reason?: string | null;
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
          delegate_id: string;
          ends_on: string;
          id: string;
          manager_id: string;
          org_id: string;
          starts_on: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          delegate_id: string;
          ends_on: string;
          id?: string;
          manager_id: string;
          org_id: string;
          starts_on: string;
        };
        Update: {
          created_at?: string;
          delegate_id?: string;
          ends_on?: string;
          id?: string;
          manager_id?: string;
          org_id?: string;
          starts_on?: string;
        };
        Relationships: [
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
          idle: boolean;
          last_checkin_at: string | null;
          last_checkin_outcome: Database["public"]["Enums"]["checkin_outcome"] | null;
          last_contact_at: string | null;
          locked: boolean;
          org_id: string;
          permission_missing: boolean;
          project_id: string | null;
          since: string;
          status: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          call_sources?: string[];
          idle?: boolean;
          last_checkin_at?: string | null;
          last_checkin_outcome?: Database["public"]["Enums"]["checkin_outcome"] | null;
          last_contact_at?: string | null;
          locked?: boolean;
          org_id: string;
          permission_missing?: boolean;
          project_id?: string | null;
          since?: string;
          status?: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        Update: {
          call_sources?: string[];
          idle?: boolean;
          last_checkin_at?: string | null;
          last_checkin_outcome?: Database["public"]["Enums"]["checkin_outcome"] | null;
          last_contact_at?: string | null;
          locked?: boolean;
          org_id?: string;
          permission_missing?: boolean;
          project_id?: string | null;
          since?: string;
          status?: Database["public"]["Enums"]["presence_status"];
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
          start_at: string;
          status: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          end_at?: string | null;
          id?: string;
          org_id: string;
          start_at: string;
          status: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        Update: {
          end_at?: string | null;
          id?: string;
          org_id?: string;
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
      users: {
        Row: {
          active: boolean;
          approval_required: boolean;
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
          timezone: string | null;
          user_id: string | null;
        };
        ComputedFields: never;
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
    Functions: {
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
      can_approve_for: { Args: { target: string }; Returns: boolean };
      can_view_user: { Args: { target: string }; Returns: boolean };
      create_org: {
        Args: {
          full_name?: string;
          org_name: string;
          region_preset?: Database["public"]["Enums"]["region_preset"];
          timezone?: string;
        };
        Returns: string;
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
      revoke_device: { Args: { p_device_id: string }; Returns: undefined };
      set_user_active: { Args: { p_active: boolean; p_user_id: string }; Returns: undefined };
    };
    Enums: {
      checkin_outcome: "pass" | "miss" | "failed";
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
      checkin_outcome: ["pass", "miss", "failed"],
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
      user_role: ["owner", "admin", "manager", "employee"],
    },
  },
} as const;
