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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      ai_settings: {
        Row: {
          auto_qualify_enabled: boolean
          auto_reply_enabled: boolean
          business_context: string
          enabled: boolean
          handle_inbound_audio: string
          handoff_rules: string
          max_ai_replies_per_thread: number
          organization_id: string
          tone: string
          updated_at: string
        }
        Insert: {
          auto_qualify_enabled?: boolean
          auto_reply_enabled?: boolean
          business_context?: string
          enabled?: boolean
          handle_inbound_audio?: string
          handoff_rules?: string
          max_ai_replies_per_thread?: number
          organization_id: string
          tone?: string
          updated_at?: string
        }
        Update: {
          auto_qualify_enabled?: boolean
          auto_reply_enabled?: boolean
          business_context?: string
          enabled?: boolean
          handle_inbound_audio?: string
          handoff_rules?: string
          max_ai_replies_per_thread?: number
          organization_id?: string
          tone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_ledger: {
        Row: {
          action: string
          billable_units: number
          conversation_id: string | null
          created_at: string
          estimated_cost_micros: number
          id: number
          input_tokens: number
          model: string
          organization_id: string
          output_tokens: number
          stripe_meter_reported_at: string | null
          usage_period_id: number | null
        }
        Insert: {
          action: string
          billable_units?: number
          conversation_id?: string | null
          created_at?: string
          estimated_cost_micros?: number
          id?: never
          input_tokens?: number
          model?: string
          organization_id: string
          output_tokens?: number
          stripe_meter_reported_at?: string | null
          usage_period_id?: number | null
        }
        Update: {
          action?: string
          billable_units?: number
          conversation_id?: string | null
          created_at?: string
          estimated_cost_micros?: number
          id?: never
          input_tokens?: number
          model?: string
          organization_id?: string
          output_tokens?: number
          stripe_meter_reported_at?: string | null
          usage_period_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_ledger_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "ai_usage_ledger_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_ledger_usage_period_id_fkey"
            columns: ["usage_period_id"]
            isOneToOne: false
            referencedRelation: "org_usage_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_connect_sessions: {
        Row: {
          completed_at: string | null
          connected_channel_id: string | null
          created_at: string
          encrypted_provider_payload: string | null
          error_code: string | null
          expires_at: string
          id: string
          organization_id: string
          platform: string
          status: string
          target_channel_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          connected_channel_id?: string | null
          created_at?: string
          encrypted_provider_payload?: string | null
          error_code?: string | null
          expires_at: string
          id: string
          organization_id: string
          platform: string
          status?: string
          target_channel_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          connected_channel_id?: string | null
          created_at?: string
          encrypted_provider_payload?: string | null
          error_code?: string | null
          expires_at?: string
          id?: string
          organization_id?: string
          platform?: string
          status?: string
          target_channel_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_connect_sessions_connected_channel_fk"
            columns: ["organization_id", "connected_channel_id"]
            isOneToOne: false
            referencedRelation: "connected_channels"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "channel_connect_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_connect_sessions_target_channel_fk"
            columns: ["organization_id", "target_channel_id"]
            isOneToOne: false
            referencedRelation: "connected_channels"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "channel_connect_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      connected_channels: {
        Row: {
          created_at: string
          display_name: string
          external_account_id: string
          handle_or_phone: string
          id: string
          metadata: Json
          organization_id: string
          platform: string
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          external_account_id: string
          handle_or_phone?: string
          id?: string
          metadata?: Json
          organization_id: string
          platform: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          external_account_id?: string
          handle_or_phone?: string
          id?: string
          metadata?: Json
          organization_id?: string
          platform?: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connected_channels_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_identities: {
        Row: {
          contact_id: string
          created_at: string
          external_user_id: string
          id: string
          organization_id: string
          platform: string
          username_or_phone: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          external_user_id: string
          id?: string
          organization_id: string
          platform: string
          username_or_phone?: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          external_user_id?: string
          id?: string
          organization_id?: string
          platform?: string
          username_or_phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_identities_organization_id_contact_id_fkey"
            columns: ["organization_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "contact_identities_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_notes: {
        Row: {
          author_user_id: string | null
          body: string
          contact_id: string
          conversation_id: string | null
          created_at: string
          id: number
          organization_id: string
          updated_at: string
        }
        Insert: {
          author_user_id?: string | null
          body: string
          contact_id: string
          conversation_id?: string | null
          created_at?: string
          id?: never
          organization_id: string
          updated_at?: string
        }
        Update: {
          author_user_id?: string | null
          body?: string
          contact_id?: string
          conversation_id?: string | null
          created_at?: string
          id?: never
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_notes_author_user_id_fkey"
            columns: ["author_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_notes_organization_id_contact_id_fkey"
            columns: ["organization_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "contact_notes_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "contact_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          ai_intent_label: string | null
          avatar_url: string | null
          company: string | null
          created_at: string
          email: string | null
          id: string
          lead_score: number
          lead_summary: string | null
          name: string
          next_step_at: string | null
          next_step_title: string | null
          organization_id: string
          owner_user_id: string | null
          phone: string | null
          role_title: string | null
          tags: string[]
          updated_at: string
        }
        Insert: {
          ai_intent_label?: string | null
          avatar_url?: string | null
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          lead_score?: number
          lead_summary?: string | null
          name: string
          next_step_at?: string | null
          next_step_title?: string | null
          organization_id: string
          owner_user_id?: string | null
          phone?: string | null
          role_title?: string | null
          tags?: string[]
          updated_at?: string
        }
        Update: {
          ai_intent_label?: string | null
          avatar_url?: string | null
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          lead_score?: number
          lead_summary?: string | null
          name?: string
          next_step_at?: string | null
          next_step_title?: string | null
          organization_id?: string
          owner_user_id?: string | null
          phone?: string | null
          role_title?: string | null
          tags?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          ai_handoff_reason: string | null
          ai_paused: boolean
          ai_processing_locked_until: string | null
          ai_reply_count: number
          assigned_to: string | null
          channel_id: string
          contact_id: string
          created_at: string
          external_thread_id: string
          id: string
          last_inbound_at: string | null
          last_message_at: string
          last_message_preview: string
          last_processed_inbound_message_id: number | null
          needs_reply: boolean
          organization_id: string
          platform: string
          status: string
          unread_count: number
          updated_at: string
        }
        Insert: {
          ai_handoff_reason?: string | null
          ai_paused?: boolean
          ai_processing_locked_until?: string | null
          ai_reply_count?: number
          assigned_to?: string | null
          channel_id: string
          contact_id: string
          created_at?: string
          external_thread_id: string
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string
          last_message_preview?: string
          last_processed_inbound_message_id?: number | null
          needs_reply?: boolean
          organization_id: string
          platform: string
          status?: string
          unread_count?: number
          updated_at?: string
        }
        Update: {
          ai_handoff_reason?: string | null
          ai_paused?: boolean
          ai_processing_locked_until?: string | null
          ai_reply_count?: number
          assigned_to?: string | null
          channel_id?: string
          contact_id?: string
          created_at?: string
          external_thread_id?: string
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string
          last_message_preview?: string
          last_processed_inbound_message_id?: number | null
          needs_reply?: boolean
          organization_id?: string
          platform?: string
          status?: string
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_organization_id_channel_id_fkey"
            columns: ["organization_id", "channel_id"]
            isOneToOne: false
            referencedRelation: "connected_channels"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversations_organization_id_contact_id_fkey"
            columns: ["organization_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      deals: {
        Row: {
          ai_last_reason: string | null
          contact_id: string
          conversation_id: string | null
          created_at: string
          currency: string
          deal_type: string
          id: string
          last_moved_by: string
          next_step_at: string | null
          next_step_title: string | null
          organization_id: string
          owner_user_id: string | null
          pipeline_id: string
          position: number
          qualification_data: Json
          stage_id: string
          title: string
          updated_at: string
          value_cents: number
        }
        Insert: {
          ai_last_reason?: string | null
          contact_id: string
          conversation_id?: string | null
          created_at?: string
          currency?: string
          deal_type?: string
          id?: string
          last_moved_by?: string
          next_step_at?: string | null
          next_step_title?: string | null
          organization_id: string
          owner_user_id?: string | null
          pipeline_id: string
          position: number
          qualification_data?: Json
          stage_id: string
          title: string
          updated_at?: string
          value_cents?: number
        }
        Update: {
          ai_last_reason?: string | null
          contact_id?: string
          conversation_id?: string | null
          created_at?: string
          currency?: string
          deal_type?: string
          id?: string
          last_moved_by?: string
          next_step_at?: string | null
          next_step_title?: string | null
          organization_id?: string
          owner_user_id?: string | null
          pipeline_id?: string
          position?: number
          qualification_data?: Json
          stage_id?: string
          title?: string
          updated_at?: string
          value_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "deals_organization_id_contact_id_fkey"
            columns: ["organization_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "deals_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "deals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_organization_id_pipeline_id_fkey"
            columns: ["organization_id", "pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "deals_organization_id_stage_id_fkey"
            columns: ["organization_id", "stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "deals_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_chunks: {
        Row: {
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          fts: unknown
          id: number
          organization_id: string
        }
        Insert: {
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          fts?: unknown
          id?: never
          organization_id: string
        }
        Update: {
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          fts?: unknown
          id?: never
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_chunks_organization_id_document_id_fkey"
            columns: ["organization_id", "document_id"]
            isOneToOne: false
            referencedRelation: "knowledge_documents"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "knowledge_chunks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_documents: {
        Row: {
          content_preview: string | null
          created_at: string
          embedding_model: string
          error_detail: string | null
          id: string
          organization_id: string
          source_type: string
          source_url: string | null
          status: string
          storage_path: string | null
          subtitle: string | null
          title: string
          updated_at: string
        }
        Insert: {
          content_preview?: string | null
          created_at?: string
          embedding_model?: string
          error_detail?: string | null
          id?: string
          organization_id: string
          source_type: string
          source_url?: string | null
          status?: string
          storage_path?: string | null
          subtitle?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          content_preview?: string | null
          created_at?: string
          embedding_model?: string
          error_detail?: string | null
          id?: string
          organization_id?: string
          source_type?: string
          source_url?: string | null
          status?: string
          storage_path?: string | null
          subtitle?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          attachments: Json
          body: string
          channel_id: string
          conversation_id: string
          created_at: string
          direction: string
          error_code: string | null
          error_detail: string | null
          external_message_id: string | null
          id: number
          organization_id: string
          sender_label: string | null
          sender_type: string
          sender_user_id: string | null
          status: string
        }
        Insert: {
          attachments?: Json
          body?: string
          channel_id: string
          conversation_id: string
          created_at?: string
          direction: string
          error_code?: string | null
          error_detail?: string | null
          external_message_id?: string | null
          id?: never
          organization_id: string
          sender_label?: string | null
          sender_type: string
          sender_user_id?: string | null
          status?: string
        }
        Update: {
          attachments?: Json
          body?: string
          channel_id?: string
          conversation_id?: string
          created_at?: string
          direction?: string
          error_code?: string | null
          error_detail?: string | null
          external_message_id?: string | null
          id?: never
          organization_id?: string
          sender_label?: string | null
          sender_type?: string
          sender_user_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_organization_id_channel_id_fkey"
            columns: ["organization_id", "channel_id"]
            isOneToOne: false
            referencedRelation: "connected_channels"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "messages_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_user_id_fkey"
            columns: ["sender_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      org_usage_periods: {
        Row: {
          created_at: string
          draft_count: number
          id: number
          included_ai_replies: number
          organization_id: string
          overage_ai_replies: number
          period_end: string
          period_start: string
          test_chat_count: number
          updated_at: string
          used_ai_replies: number
        }
        Insert: {
          created_at?: string
          draft_count?: number
          id?: never
          included_ai_replies: number
          organization_id: string
          overage_ai_replies?: number
          period_end: string
          period_start: string
          test_chat_count?: number
          updated_at?: string
          used_ai_replies?: number
        }
        Update: {
          created_at?: string
          draft_count?: number
          id?: never
          included_ai_replies?: number
          organization_id?: string
          overage_ai_replies?: number
          period_end?: string
          period_start?: string
          test_chat_count?: number
          updated_at?: string
          used_ai_replies?: number
        }
        Relationships: [
          {
            foreignKeyName: "org_usage_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          organization_id: string
          role: string
          status: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          organization_id: string
          role: string
          status?: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string
          role?: string
          status?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          organization_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          ai_overage_enabled: boolean
          billing_mode: string
          channel_slots: number
          created_at: string
          currency: string
          current_period_end: string
          current_period_start: string
          id: string
          included_ai_replies_per_channel: number
          industry: string
          kb_document_limit: number
          language: string
          name: string
          slug: string
          stripe_ai_overage_item_id: string | null
          stripe_channel_item_id: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string
          trial_ends_at: string | null
          updated_at: string
          zernio_profile_id: string | null
        }
        Insert: {
          ai_overage_enabled?: boolean
          billing_mode?: string
          channel_slots?: number
          created_at?: string
          currency?: string
          current_period_end?: string
          current_period_start?: string
          id?: string
          included_ai_replies_per_channel?: number
          industry?: string
          kb_document_limit?: number
          language?: string
          name: string
          slug: string
          stripe_ai_overage_item_id?: string | null
          stripe_channel_item_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          trial_ends_at?: string | null
          updated_at?: string
          zernio_profile_id?: string | null
        }
        Update: {
          ai_overage_enabled?: boolean
          billing_mode?: string
          channel_slots?: number
          created_at?: string
          currency?: string
          current_period_end?: string
          current_period_start?: string
          id?: string
          included_ai_replies_per_channel?: number
          industry?: string
          kb_document_limit?: number
          language?: string
          name?: string
          slug?: string
          stripe_ai_overage_item_id?: string | null
          stripe_channel_item_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          trial_ends_at?: string | null
          updated_at?: string
          zernio_profile_id?: string | null
        }
        Relationships: []
      }
      pipeline_stages: {
        Row: {
          ai_qualification_hint: string
          color: string
          created_at: string
          id: string
          is_terminal: boolean
          name: string
          organization_id: string
          pipeline_id: string
          position: number
          slug: string
        }
        Insert: {
          ai_qualification_hint?: string
          color?: string
          created_at?: string
          id?: string
          is_terminal?: boolean
          name: string
          organization_id: string
          pipeline_id: string
          position: number
          slug: string
        }
        Update: {
          ai_qualification_hint?: string
          color?: string
          created_at?: string
          id?: string
          is_terminal?: boolean
          name?: string
          organization_id?: string
          pipeline_id?: string
          position?: number
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_stages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pipeline_stages_organization_id_pipeline_id_fkey"
            columns: ["organization_id", "pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      pipelines: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          organization_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipelines_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          event_id: string
          event_type: string
          processed_at: string
        }
        Insert: {
          event_id: string
          event_type: string
          processed_at?: string
        }
        Update: {
          event_id?: string
          event_type?: string
          processed_at?: string
        }
        Relationships: []
      }
      zernio_webhook_events: {
        Row: {
          event_id: string
          event_type: string
          processed_at: string
        }
        Insert: {
          event_id: string
          event_type: string
          processed_at?: string
        }
        Update: {
          event_id?: string
          event_type?: string
          processed_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_conversation_ai_lease_rpc: {
        Args: {
          p_conversation_id: string
          p_lease_seconds?: number
          p_message_id: number
          p_org_id: string
        }
        Returns: {
          acquired: boolean
          latest_inbound_id: number
          reason: string
        }[]
      }
      consume_ai_quota_rpc: {
        Args: { p_action?: string; p_org_id: string }
        Returns: {
          allowed: boolean
          draft_count: number
          included_ai_replies: number
          overage_ai_replies: number
          reason: string
          test_chat_count: number
          usage_period_id: number
          used_ai_replies: number
        }[]
      }
      release_conversation_ai_lease_rpc: {
        Args: {
          p_conversation_id: string
          p_org_id: string
          p_processed_message_id?: number
        }
        Returns: undefined
      }
      search_knowledge_hybrid_rpc: {
        Args: {
          p_limit?: number
          p_org_id: string
          p_query_embedding?: string
          p_query_text: string
        }
        Returns: {
          chunk_id: number
          content: string
          document_id: string
          document_title: string
          score: number
        }[]
      }
      verify_conversation_ready_for_ai_send_rpc: {
        Args: {
          p_conversation_id: string
          p_expected_inbound_message_id: number
          p_org_id: string
        }
        Returns: {
          ready: boolean
          reason: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
