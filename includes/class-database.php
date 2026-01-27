<?php
/**
 * Database Handler
 *
 * Creates and manages custom database tables
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Database class
 */
class KPT_Database {
    
    /**
     * Create all custom tables
     */
    public static function create_tables() {
        global $wpdb;
        
        $charset_collate = $wpdb->get_charset_collate();
        
        require_once(ABSPATH . 'wp-admin/includes/upgrade.php');
        
        // Table 1: Team Members
        $table_name = $wpdb->prefix . 'kpt_team_members';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            user_id bigint(20) UNSIGNED NOT NULL,
            role varchar(50) NOT NULL,
            trade_type varchar(100) DEFAULT NULL,
            permissions longtext DEFAULT NULL,
            added_by bigint(20) UNSIGNED DEFAULT NULL,
            created_at datetime DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY  (id),
            KEY project_id (project_id),
            KEY user_id (user_id)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 2: Checklist Items
        $table_name = $wpdb->prefix . 'kpt_checklist_items';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            stage int(11) NOT NULL,
            item_text text NOT NULL,
            is_completed tinyint(1) DEFAULT 0,
            completed_by bigint(20) UNSIGNED DEFAULT NULL,
            completed_at datetime DEFAULT NULL,
            sort_order int(11) DEFAULT 0,
            trade_type varchar(100) DEFAULT NULL,
            notes text DEFAULT NULL,
            photo_url varchar(255) DEFAULT NULL,
            PRIMARY KEY  (id),
            KEY project_id (project_id),
            KEY stage (stage)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 3: Trade Bids
        $table_name = $wpdb->prefix . 'kpt_trade_bids';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            trade_user_id bigint(20) UNSIGNED NOT NULL,
            trade_type varchar(100) NOT NULL,
            bid_number varchar(50) DEFAULT NULL,
            line_items longtext DEFAULT NULL,
            subtotal decimal(10,2) DEFAULT 0.00,
            tax decimal(10,2) DEFAULT 0.00,
            total decimal(10,2) DEFAULT 0.00,
            status varchar(50) DEFAULT 'draft',
            submitted_at datetime DEFAULT NULL,
            reviewed_at datetime DEFAULT NULL,
            reviewed_by bigint(20) UNSIGNED DEFAULT NULL,
            notes text DEFAULT NULL,
            revision_notes text DEFAULT NULL,
            PRIMARY KEY  (id),
            KEY project_id (project_id),
            KEY trade_user_id (trade_user_id),
            KEY status (status)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 4: Bid Line Items (Templates)
        $table_name = $wpdb->prefix . 'kpt_bid_line_items';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            trade_type varchar(100) NOT NULL,
            item_name varchar(255) NOT NULL,
            item_description text DEFAULT NULL,
            unit varchar(50) DEFAULT NULL,
            is_required tinyint(1) DEFAULT 0,
            sort_order int(11) DEFAULT 0,
            PRIMARY KEY  (id),
            KEY trade_type (trade_type)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 5: Change Orders
        $table_name = $wpdb->prefix . 'kpt_change_orders';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            title varchar(255) NOT NULL,
            description text DEFAULT NULL,
            amount decimal(10,2) DEFAULT 0.00,
            status varchar(50) DEFAULT 'pending',
            requested_by bigint(20) UNSIGNED DEFAULT NULL,
            approved_by bigint(20) UNSIGNED DEFAULT NULL,
            created_at datetime DEFAULT CURRENT_TIMESTAMP,
            approved_at datetime DEFAULT NULL,
            PRIMARY KEY  (id),
            KEY project_id (project_id),
            KEY status (status)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 6: Proposals
        $table_name = $wpdb->prefix . 'kpt_proposals';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            proposal_number varchar(50) NOT NULL,
            version int(11) DEFAULT 1,
            subtotal decimal(10,2) DEFAULT 0.00,
            tax decimal(10,2) DEFAULT 0.00,
            total decimal(10,2) DEFAULT 0.00,
            deposit_amount decimal(10,2) DEFAULT 0.00,
            deposit_percentage int(11) DEFAULT 0,
            line_items longtext DEFAULT NULL,
            terms_text text DEFAULT NULL,
            status varchar(50) DEFAULT 'draft',
            access_token varchar(64) DEFAULT NULL,
            sent_at datetime DEFAULT NULL,
            viewed_at datetime DEFAULT NULL,
            signed_at datetime DEFAULT NULL,
            client_signature longtext DEFAULT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY access_token (access_token),
            KEY project_id (project_id),
            KEY status (status)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 7: Leads
        $table_name = $wpdb->prefix . 'kpt_leads';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            first_name varchar(100) NOT NULL,
            last_name varchar(100) NOT NULL,
            email varchar(255) NOT NULL,
            phone varchar(50) DEFAULT NULL,
            address varchar(255) DEFAULT NULL,
            city varchar(100) DEFAULT NULL,
            province varchar(50) DEFAULT NULL,
            postal_code varchar(20) DEFAULT NULL,
            project_type varchar(100) DEFAULT NULL,
            project_description text DEFAULT NULL,
            estimated_budget decimal(10,2) DEFAULT NULL,
            timeline varchar(100) DEFAULT NULL,
            source varchar(100) DEFAULT NULL,
            utm_source varchar(100) DEFAULT NULL,
            utm_medium varchar(100) DEFAULT NULL,
            utm_campaign varchar(100) DEFAULT NULL,
            status varchar(50) DEFAULT 'new',
            stage varchar(50) DEFAULT 'inquiry',
            priority varchar(20) DEFAULT 'medium',
            assigned_to bigint(20) UNSIGNED DEFAULT NULL,
            estimated_value decimal(10,2) DEFAULT NULL,
            converted_to_project bigint(20) UNSIGNED DEFAULT NULL,
            converted_at datetime DEFAULT NULL,
            created_at datetime DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY  (id),
            KEY status (status),
            KEY stage (stage),
            KEY assigned_to (assigned_to)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 8: Files
        $table_name = $wpdb->prefix . 'kpt_files';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            folder_id bigint(20) UNSIGNED DEFAULT NULL,
            file_name varchar(255) NOT NULL,
            file_url varchar(500) NOT NULL,
            file_type varchar(100) DEFAULT NULL,
            uploaded_by bigint(20) UNSIGNED DEFAULT NULL,
            created_at datetime DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY  (id),
            KEY project_id (project_id),
            KEY folder_id (folder_id)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Table 9: Signoffs
        $table_name = $wpdb->prefix . 'kpt_signoffs';
        $sql = "CREATE TABLE $table_name (
            id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
            project_id bigint(20) UNSIGNED NOT NULL,
            stage int(11) DEFAULT NULL,
            signoff_type varchar(50) NOT NULL,
            status varchar(50) DEFAULT 'pending',
            signed_by bigint(20) UNSIGNED DEFAULT NULL,
            signature_data longtext DEFAULT NULL,
            signed_at datetime DEFAULT NULL,
            PRIMARY KEY  (id),
            KEY project_id (project_id),
            KEY status (status)
        ) $charset_collate;";
        dbDelta($sql);
        
        // Update version option
        update_option('kpt_db_version', KPT_VERSION);
    }
}
