export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_events: {
        Row: {
          check_type: Database["public"]["Enums"]["audit_check_type"]
          created_at: string
          findings: Json
          id: string
          profile_id: string | null
          result: string
          run_at: string
          target_id: string | null
          target_table: string | null
        }
        Insert: {
          check_type: Database["public"]["Enums"]["audit_check_type"]
          created_at?: string
          findings?: Json
          id?: string
          profile_id?: string | null
          result?: string
          run_at?: string
          target_id?: string | null
          target_table?: string | null
        }
        Update: {
          check_type?: Database["public"]["Enums"]["audit_check_type"]
          created_at?: string
          findings?: Json
          id?: string
          profile_id?: string | null
          result?: string
          run_at?: string
          target_id?: string | null
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "research_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_jobs: {
        Row: {
          apify_run_id: string | null
          created_at: string
          duplicate_count: number
          error_text: string | null
          failed_count: number
          fetched_count: number
          finished_at: string | null
          id: string
          new_count: number
          profile_id: string | null
          run_params: Json
          source_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          updated_at: string
        }
        Insert: {
          apify_run_id?: string | null
          created_at?: string
          duplicate_count?: number
          error_text?: string | null
          failed_count?: number
          fetched_count?: number
          finished_at?: string | null
          id?: string
          new_count?: number
          profile_id?: string | null
          run_params?: Json
          source_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          updated_at?: string
        }
        Update: {
          apify_run_id?: string | null
          created_at?: string
          duplicate_count?: number
          error_text?: string | null
          failed_count?: number
          fetched_count?: number
          finished_at?: string | null
          id?: string
          new_count?: number
          profile_id?: string | null
          run_params?: Json
          source_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_jobs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "research_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_jobs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      consumer_keys: {
        Row: {
          consumer_app: string
          created_at: string
          id: string
          is_active: boolean
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          note: string | null
          profile_id: string
          revoked_at: string | null
          updated_at: string
        }
        Insert: {
          consumer_app: string
          created_at?: string
          id?: string
          is_active?: boolean
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          note?: string | null
          profile_id: string
          revoked_at?: string | null
          updated_at?: string
        }
        Update: {
          consumer_app?: string
          created_at?: string
          id?: string
          is_active?: boolean
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          note?: string | null
          profile_id?: string
          revoked_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "consumer_keys_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "research_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      normalized_item_profile_exposure: {
        Row: {
          created_at: string
          id: string
          normalized_item_id: string
          note: string | null
          profile_id: string
          promoted: boolean
          promoted_at: string | null
          promoted_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          normalized_item_id: string
          note?: string | null
          profile_id: string
          promoted?: boolean
          promoted_at?: string | null
          promoted_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          normalized_item_id?: string
          note?: string | null
          profile_id?: string
          promoted?: boolean
          promoted_at?: string | null
          promoted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "normalized_item_profile_exposure_normalized_item_id_fkey"
            columns: ["normalized_item_id"]
            isOneToOne: false
            referencedRelation: "normalized_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "normalized_item_profile_exposure_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "research_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      normalized_items: {
        Row: {
          category: string | null
          collected_at: string
          created_at: string
          id: string
          institution_class: Database["public"]["Enums"]["institution_class"]
          is_official_domain: boolean
          is_primary_document: boolean
          jurisdiction_hint: string | null
          payload: Json
          publication_status: Database["public"]["Enums"]["publication_status"]
          raw_item_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          source_id: string
          source_url: string
          traceability_level: Database["public"]["Enums"]["traceability_level"]
          updated_at: string
          verification_status: Database["public"]["Enums"]["verification_status"]
        }
        Insert: {
          category?: string | null
          collected_at: string
          created_at?: string
          id?: string
          institution_class: Database["public"]["Enums"]["institution_class"]
          is_official_domain: boolean
          is_primary_document: boolean
          jurisdiction_hint?: string | null
          payload?: Json
          publication_status?: Database["public"]["Enums"]["publication_status"]
          raw_item_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_id: string
          source_url: string
          traceability_level: Database["public"]["Enums"]["traceability_level"]
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["verification_status"]
        }
        Update: {
          category?: string | null
          collected_at?: string
          created_at?: string
          id?: string
          institution_class?: Database["public"]["Enums"]["institution_class"]
          is_official_domain?: boolean
          is_primary_document?: boolean
          jurisdiction_hint?: string | null
          payload?: Json
          publication_status?: Database["public"]["Enums"]["publication_status"]
          raw_item_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_id?: string
          source_url?: string
          traceability_level?: Database["public"]["Enums"]["traceability_level"]
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["verification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "normalized_items_raw_item_id_fkey"
            columns: ["raw_item_id"]
            isOneToOne: true
            referencedRelation: "raw_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "normalized_items_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_items: {
        Row: {
          apify_actor_id: string | null
          apify_run_id: string | null
          canonical_url: string | null
          collected_at: string
          collection_method: Database["public"]["Enums"]["collection_method"]
          collector_version: string | null
          content_hash: string
          content_type: string | null
          created_at: string
          http_status: number | null
          id: string
          institution_class: Database["public"]["Enums"]["institution_class"]
          is_official_domain: boolean
          is_primary_document: boolean
          job_id: string | null
          language: string | null
          raw_payload: Json
          source_id: string
          source_url: string
          traceability_level: Database["public"]["Enums"]["traceability_level"]
        }
        Insert: {
          apify_actor_id?: string | null
          apify_run_id?: string | null
          canonical_url?: string | null
          collected_at?: string
          collection_method?: Database["public"]["Enums"]["collection_method"]
          collector_version?: string | null
          content_hash: string
          content_type?: string | null
          created_at?: string
          http_status?: number | null
          id?: string
          institution_class: Database["public"]["Enums"]["institution_class"]
          is_official_domain: boolean
          is_primary_document: boolean
          job_id?: string | null
          language?: string | null
          raw_payload?: Json
          source_id: string
          source_url: string
          traceability_level: Database["public"]["Enums"]["traceability_level"]
        }
        Update: {
          apify_actor_id?: string | null
          apify_run_id?: string | null
          canonical_url?: string | null
          collected_at?: string
          collection_method?: Database["public"]["Enums"]["collection_method"]
          collector_version?: string | null
          content_hash?: string
          content_type?: string | null
          created_at?: string
          http_status?: number | null
          id?: string
          institution_class?: Database["public"]["Enums"]["institution_class"]
          is_official_domain?: boolean
          is_primary_document?: boolean
          job_id?: string | null
          language?: string | null
          raw_payload?: Json
          source_id?: string
          source_url?: string
          traceability_level?: Database["public"]["Enums"]["traceability_level"]
        }
        Relationships: [
          {
            foreignKeyName: "raw_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "collection_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_items_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      research_profile_tier_policies: {
        Row: {
          created_at: string
          created_by: string | null
          exposure: Json
          id: string
          is_active: boolean
          policy: Json
          profile_id: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          exposure: Json
          id?: string
          is_active?: boolean
          policy: Json
          profile_id: string
          version: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          exposure?: Json
          id?: string
          is_active?: boolean
          policy?: Json
          profile_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "research_profile_tier_policies_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "research_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      research_profiles: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      sources: {
        Row: {
          collection_method: Database["public"]["Enums"]["collection_method"]
          created_at: string
          domain: string
          id: string
          institution_class: Database["public"]["Enums"]["institution_class"]
          is_active: boolean
          is_official_domain: boolean
          is_primary_document: boolean
          name: string
          notes: string | null
          robots_checked_at: string | null
          robots_status: string
          start_url: string
          tos_checked_at: string | null
          tos_status: string
          tos_url: string | null
          traceability_level: Database["public"]["Enums"]["traceability_level"]
          updated_at: string
        }
        Insert: {
          collection_method?: Database["public"]["Enums"]["collection_method"]
          created_at?: string
          domain: string
          id?: string
          institution_class?: Database["public"]["Enums"]["institution_class"]
          is_active?: boolean
          is_official_domain?: boolean
          is_primary_document?: boolean
          name: string
          notes?: string | null
          robots_checked_at?: string | null
          robots_status?: string
          start_url: string
          tos_checked_at?: string | null
          tos_status?: string
          tos_url?: string | null
          traceability_level?: Database["public"]["Enums"]["traceability_level"]
          updated_at?: string
        }
        Update: {
          collection_method?: Database["public"]["Enums"]["collection_method"]
          created_at?: string
          domain?: string
          id?: string
          institution_class?: Database["public"]["Enums"]["institution_class"]
          is_active?: boolean
          is_official_domain?: boolean
          is_primary_document?: boolean
          name?: string
          notes?: string | null
          robots_checked_at?: string | null
          robots_status?: string
          start_url?: string
          tos_checked_at?: string | null
          tos_status?: string
          tos_url?: string | null
          traceability_level?: Database["public"]["Enums"]["traceability_level"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      api_list_items: {
        Args: {
          p_cursor_id?: string
          p_cursor_updated_at?: string
          p_limit?: number
          p_profile_id: string
          p_updated_since?: string
        }
        Returns: {
          category: string
          collected_at: string
          id: string
          jurisdiction_hint: string
          payload: Json
          policy_version: number
          source_url: string
          tier_label: Database["public"]["Enums"]["tier_label"]
          updated_at: string
        }[]
      }
      eval_policy_node: { Args: { facts: Json; node: Json }; Returns: boolean }
      evaluate_tier_policy:
        | {
            Args: { facts: Json; policy: Json }
            Returns: Database["public"]["Enums"]["tier_label"]
          }
        | {
            Args: {
              institution_class: Database["public"]["Enums"]["institution_class"]
              is_official_domain: boolean
              is_primary_document: boolean
              policy: Json
              traceability_level: Database["public"]["Enums"]["traceability_level"]
            }
            Returns: Database["public"]["Enums"]["tier_label"]
          }
      get_staff_item_tier_matrix: {
        Args: never
        Returns: {
          category: string
          collected_at: string
          institution_class: Database["public"]["Enums"]["institution_class"]
          is_official_domain: boolean
          is_primary_document: boolean
          jurisdiction_hint: string
          normalized_item_id: string
          policy_version: number
          profile_id: string
          profile_slug: string
          promoted_for_profile: boolean
          publication_status: Database["public"]["Enums"]["publication_status"]
          resolved_tier: Database["public"]["Enums"]["tier_label"]
          reviewed_at: string
          source_id: string
          source_url: string
          traceability_level: Database["public"]["Enums"]["traceability_level"]
          updated_at: string
          verification_status: Database["public"]["Enums"]["verification_status"]
        }[]
      }
      is_valid_exposure_policy: { Args: { exposure: Json }; Returns: boolean }
      is_valid_policy_node: {
        Args: { depth?: number; node: Json }
        Returns: boolean
      }
      is_valid_tier_policy: { Args: { policy: Json }; Returns: boolean }
    }
    Enums: {
      audit_check_type:
        | "duplicate"
        | "consistency"
        | "tier_drift"
        | "tos_recheck"
        | "robots_recheck"
        | "review_status_change"
      collection_method: "apify" | "http" | "api" | "manual"
      institution_class:
        | "government"
        | "intergovernmental"
        | "court"
        | "academic"
        | "professional_body"
        | "registered_media"
        | "commercial"
        | "unknown"
      job_status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
      publication_status: "internal_only" | "eligible"
      tier_label: "T1" | "T2" | "T3" | "T4" | "T5"
      traceability_level:
        | "direct_url"
        | "domain_indicated"
        | "third_party_hosted"
        | "untraceable"
      verification_status: "unreviewed" | "reviewed" | "rejected"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      audit_check_type: [
        "duplicate",
        "consistency",
        "tier_drift",
        "tos_recheck",
        "robots_recheck",
        "review_status_change",
      ],
      collection_method: ["apify", "http", "api", "manual"],
      institution_class: [
        "government",
        "intergovernmental",
        "court",
        "academic",
        "professional_body",
        "registered_media",
        "commercial",
        "unknown",
      ],
      job_status: ["queued", "running", "succeeded", "failed", "cancelled"],
      publication_status: ["internal_only", "eligible"],
      tier_label: ["T1", "T2", "T3", "T4", "T5"],
      traceability_level: [
        "direct_url",
        "domain_indicated",
        "third_party_hosted",
        "untraceable",
      ],
      verification_status: ["unreviewed", "reviewed", "rejected"],
    },
  },
} as const
