<?php
/**
 * Plugin Name: Kelbe Project Tracker
 * Plugin URI: https://github.com/Kwald90/kelbeplugin
 * Description: Complete business management system for renovation companies with project tracking, bidding, proposals, and CRM.
 * Version: 1.0.0
 * Author: Kelbe Construction
 * Author URI: https://kelbe.ca
 * Text Domain: kelbe-project-tracker
 * Domain Path: /languages
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * License: GPL-2.0+
 * License URI: http://www.gnu.org/licenses/gpl-2.0.txt
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

// Plugin constants
define('KPT_VERSION', '1.0.0');
define('KPT_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('KPT_PLUGIN_URL', plugin_dir_url(__FILE__));
define('KPT_PLUGIN_BASENAME', plugin_basename(__FILE__));

/**
 * Main Plugin Class
 */
class Kelbe_Project_Tracker {
    
    /**
     * Single instance of the class
     *
     * @var Kelbe_Project_Tracker
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return Kelbe_Project_Tracker
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        $this->load_dependencies();
        $this->init_hooks();
    }
    
    /**
     * Load required dependencies
     */
    private function load_dependencies() {
        // Core classes
        require_once KPT_PLUGIN_DIR . 'includes/class-database.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-project-post-type.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-checklist-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-team-manager.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-file-manager.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-change-order-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-bid-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-proposal-generator.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-proposal-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-lead-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-notification-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-signoff-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-frontend-redirect.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-ajax-handler.php';
        require_once KPT_PLUGIN_DIR . 'includes/class-shortcodes.php';
        
        // Admin classes
        require_once KPT_PLUGIN_DIR . 'includes/admin/class-admin-settings.php';
        require_once KPT_PLUGIN_DIR . 'includes/admin/class-admin-dashboard.php';
        require_once KPT_PLUGIN_DIR . 'includes/admin/class-admin-users.php';
        require_once KPT_PLUGIN_DIR . 'includes/admin/class-admin-budget.php';
        
        // Frontend classes
        require_once KPT_PLUGIN_DIR . 'includes/frontend/class-trade-portal.php';
    }
    
    /**
     * Initialize hooks
     */
    private function init_hooks() {
        // Activation/Deactivation hooks
        register_activation_hook(__FILE__, array($this, 'activate'));
        register_deactivation_hook(__FILE__, array($this, 'deactivate'));
        
        // Init hook
        add_action('init', array($this, 'init'));
        
        // Enqueue scripts and styles
        add_action('wp_enqueue_scripts', array($this, 'enqueue_frontend_assets'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_admin_assets'));
    }
    
    /**
     * Plugin activation
     */
    public function activate() {
        // Create database tables
        KPT_Database::create_tables();
        
        // Register post type (for rewrite rules)
        KPT_Project_Post_Type::register();
        
        // Flush rewrite rules
        flush_rewrite_rules();
        
        // Create default pages
        $this->create_default_pages();
        
        // Set default options
        $this->set_default_options();
    }
    
    /**
     * Plugin deactivation
     */
    public function deactivate() {
        flush_rewrite_rules();
    }
    
    /**
     * Initialize plugin
     */
    public function init() {
        // Load text domain
        load_plugin_textdomain('kelbe-project-tracker', false, dirname(KPT_PLUGIN_BASENAME) . '/languages');
        
        // Initialize classes
        KPT_Project_Post_Type::get_instance();
        KPT_Checklist_Handler::get_instance();
        KPT_Team_Manager::get_instance();
        KPT_File_Manager::get_instance();
        KPT_Change_Order_Handler::get_instance();
        KPT_Bid_Handler::get_instance();
        KPT_Proposal_Generator::get_instance();
        KPT_Proposal_Handler::get_instance();
        KPT_Lead_Handler::get_instance();
        KPT_Notification_Handler::get_instance();
        KPT_Signoff_Handler::get_instance();
        KPT_Frontend_Redirect::get_instance();
        KPT_AJAX_Handler::get_instance();
        KPT_Shortcodes::get_instance();
        
        // Admin classes (only in admin)
        if (is_admin()) {
            KPT_Admin_Settings::get_instance();
            KPT_Admin_Dashboard::get_instance();
            KPT_Admin_Users::get_instance();
            KPT_Admin_Budget::get_instance();
        }
        
        // Frontend portal
        KPT_Trade_Portal::get_instance();
    }
    
    /**
     * Enqueue frontend assets
     */
    public function enqueue_frontend_assets() {
        // CSS
        wp_enqueue_style('kpt-frontend', KPT_PLUGIN_URL . 'assets/css/frontend.css', array(), KPT_VERSION);
        wp_enqueue_style('kpt-trade-portal', KPT_PLUGIN_URL . 'assets/css/trade-portal.css', array(), KPT_VERSION);
        
        // JS
        wp_enqueue_script('kpt-frontend', KPT_PLUGIN_URL . 'assets/js/frontend.js', array('jquery'), KPT_VERSION, true);
        
        // Localize script with AJAX URL and nonce
        wp_localize_script('kpt-frontend', 'kptData', array(
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('kpt_nonce'),
            'currentUserId' => get_current_user_id(),
            'isAdmin' => current_user_can('manage_options'),
        ));
    }
    
    /**
     * Enqueue admin assets
     */
    public function enqueue_admin_assets($hook) {
        // Only load on plugin pages
        if (strpos($hook, 'kpt_') === false && strpos($hook, 'kelbe') === false) {
            return;
        }
        
        // CSS
        wp_enqueue_style('kpt-admin', KPT_PLUGIN_URL . 'assets/css/admin.css', array(), KPT_VERSION);
        
        // JS
        wp_enqueue_script('kpt-admin-settings', KPT_PLUGIN_URL . 'assets/js/admin-settings.js', array('jquery', 'wp-color-picker'), KPT_VERSION, true);
        
        // Color picker
        wp_enqueue_style('wp-color-picker');
        
        // Localize script
        wp_localize_script('kpt-admin-settings', 'kptAdminData', array(
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('kpt_admin_settings'),
        ));
    }
    
    /**
     * Create default pages
     */
    private function create_default_pages() {
        // Team Portal page
        $team_portal = get_page_by_path('team-portal');
        if (!$team_portal) {
            wp_insert_post(array(
                'post_title' => 'Team Portal',
                'post_name' => 'team-portal',
                'post_content' => '[kpt_trade_portal]',
                'post_status' => 'publish',
                'post_type' => 'page',
            ));
        }
        
        // Client Portal page
        $client_portal = get_page_by_path('client-portal');
        if (!$client_portal) {
            wp_insert_post(array(
                'post_title' => 'Client Portal',
                'post_name' => 'client-portal',
                'post_content' => '[kpt_client_portal]',
                'post_status' => 'publish',
                'post_type' => 'page',
            ));
        }
    }
    
    /**
     * Set default options
     */
    private function set_default_options() {
        // Default trade types
        if (!get_option('kpt_trade_types')) {
            $default_trades = array(
                array('name' => 'General Contractor', 'icon' => 'dashicons-hammer', 'color' => '#D6001C'),
                array('name' => 'Plumber', 'icon' => 'dashicons-admin-tools', 'color' => '#0073aa'),
                array('name' => 'Electrician', 'icon' => 'dashicons-lightbulb', 'color' => '#f0b849'),
                array('name' => 'HVAC', 'icon' => 'dashicons-calendar-alt', 'color' => '#46b450'),
                array('name' => 'Carpenter', 'icon' => 'dashicons-admin-home', 'color' => '#826200'),
                array('name' => 'Painter', 'icon' => 'dashicons-art', 'color' => '#dc3232'),
                array('name' => 'Flooring', 'icon' => 'dashicons-grid-view', 'color' => '#333333'),
            );
            update_option('kpt_trade_types', $default_trades);
        }
        
        // Default settings
        if (!get_option('kpt_settings')) {
            $default_settings = array(
                'company_name' => 'Kelbe Construction',
                'company_email' => get_option('admin_email'),
                'company_phone' => '',
                'tax_rate' => 13,
                'deposit_percentage' => 30,
                'proposal_terms' => 'Payment terms: 30% deposit, balance due on completion.',
            );
            update_option('kpt_settings', $default_settings);
        }
    }
}

/**
 * Initialize the plugin
 */
function kelbe_project_tracker_init() {
    return Kelbe_Project_Tracker::get_instance();
}

// Start the plugin
add_action('plugins_loaded', 'kelbe_project_tracker_init');
