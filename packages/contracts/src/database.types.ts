export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
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
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      checkin_events: {
        Row: {
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
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      devices: {
        Row: {
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
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          at: string;
          device_id: string;
          org_id: string;
          user_id: string;
        };
        Update: {
          at?: string;
          device_id?: string;
          org_id?: string;
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
      presence: {
        Row: {
          last_checkin_at: string | null;
          last_checkin_outcome: Database["public"]["Enums"]["checkin_outcome"] | null;
          org_id: string;
          project_id: string | null;
          since: string;
          status: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          last_checkin_at?: string | null;
          last_checkin_outcome?: Database["public"]["Enums"]["checkin_outcome"] | null;
          org_id: string;
          project_id?: string | null;
          since?: string;
          status?: Database["public"]["Enums"]["presence_status"];
          user_id: string;
        };
        Update: {
          last_checkin_at?: string | null;
          last_checkin_outcome?: Database["public"]["Enums"]["checkin_outcome"] | null;
          org_id?: string;
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
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
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
