<?php
/**
 * Admin Settings Page
 *
 * Handles the main settings page with tabs for various configuration options.
 *
 * @package Kelbe_Project_Tracker
 * @since 1.0.0
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Class KPT_Admin_Settings
 */
class KPT_Admin_Settings {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Admin_Settings
     */
    private static $instance = null;
    
    /**
     * Settings option name
     *
     * @var string
     */
    private $option_name = 'kpt_settings';
    
    /**
     * Get instance
     *
     * @return KPT_Admin_Settings
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
        add_action('admin_menu', array($this, 'add_settings_page'));
        add_action('admin_init', array($this, 'register_settings'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_scripts'));
        add_action('wp_ajax_kpt_save_settings', array($this, 'ajax_save_settings'));
        add_action('wp_ajax_kpt_upload_logo', array($this, 'ajax_upload_logo'));
    }
    
    /**
     * Add settings page to admin menu
     */
    public function add_settings_page() {
        add_menu_page(
            __('Kelbe Settings', 'kelbe-project-tracker'),
            __('Kelbe Settings', 'kelbe-project-tracker'),
            'manage_options',
            'kpt-settings',
            array($this, 'render_settings_page'),
            'dashicons-admin-generic',
            30
        );
    }
    
    /**
     * Register settings
     */
    public function register_settings() {
        register_setting($this->option_name, $this->option_name, array(
            'sanitize_callback' => array($this, 'sanitize_settings')
        ));
    }
    
    /**
     * Enqueue admin scripts
     *
     * @param string $hook Current admin page hook
     */
    public function enqueue_scripts($hook) {
        if ('toplevel_page_kpt-settings' !== $hook) {
            return;
        }
        
        wp_enqueue_media();
        wp_enqueue_style('wp-color-picker');
        wp_enqueue_script('wp-color-picker');
        wp_enqueue_script('jquery-ui-sortable');
        
        wp_enqueue_script(
            'kpt-admin-settings',
            KPT_PLUGIN_URL . 'assets/js/admin-settings.js',
            array('jquery', 'wp-color-picker', 'jquery-ui-sortable'),
            KPT_VERSION,
            true
        );
        
        wp_localize_script('kpt-admin-settings', 'kptSettings', array(
            'ajax_url' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('kpt_settings_nonce'),
            'strings' => array(
                'saved' => __('Settings saved successfully', 'kelbe-project-tracker'),
                'error' => __('Error saving settings', 'kelbe-project-tracker'),
                'confirm_delete' => __('Are you sure you want to delete this item?', 'kelbe-project-tracker')
            )
        ));
        
        wp_enqueue_style(
            'kpt-admin-settings',
            KPT_PLUGIN_URL . 'assets/css/admin-settings.css',
            array('wp-color-picker'),
            KPT_VERSION
        );
    }
    
    /**
     * Render settings page
     */
    public function render_settings_page() {
        if (!current_user_can('manage_options')) {
            wp_die(__('You do not have sufficient permissions to access this page.', 'kelbe-project-tracker'));
        }
        
        $active_tab = isset($_GET['tab']) ? sanitize_key($_GET['tab']) : 'general';
        $settings = $this->get_settings();
        
        ?>
        <div class="wrap kpt-settings-wrap">
            <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
            
            <h2 class="nav-tab-wrapper">
                <?php
                $tabs = $this->get_tabs();
                foreach ($tabs as $tab_id => $tab_name) {
                    $tab_url = add_query_arg(array('page' => 'kpt-settings', 'tab' => $tab_id), admin_url('admin.php'));
                    $active_class = ($active_tab === $tab_id) ? 'nav-tab-active' : '';
                    printf(
                        '<a href="%s" class="nav-tab %s">%s</a>',
                        esc_url($tab_url),
                        esc_attr($active_class),
                        esc_html($tab_name)
                    );
                }
                ?>
            </h2>
            
            <form method="post" action="" id="kpt-settings-form">
                <?php
                wp_nonce_field('kpt_save_settings', 'kpt_settings_nonce');
                
                switch ($active_tab) {
                    case 'general':
                        $this->render_general_tab($settings);
                        break;
                    case 'trade_types':
                        $this->render_trade_types_tab($settings);
                        break;
                    case 'notifications':
                        $this->render_notifications_tab($settings);
                        break;
                    case 'ai_reports':
                        $this->render_ai_reports_tab($settings);
                        break;
                    case 'permissions':
                        $this->render_permissions_tab($settings);
                        break;
                    case 'bid_items':
                        $this->render_bid_items_tab($settings);
                        break;
                    case 'proposals':
                        $this->render_proposals_tab($settings);
                        break;
                    case 'lead_integration':
                        $this->render_lead_integration_tab($settings);
                        break;
                }
                ?>
                
                <?php submit_button(__('Save Settings', 'kelbe-project-tracker')); ?>
            </form>
        </div>
        <?php
    }
    
    /**
     * Get settings tabs
     *
     * @return array
     */
    private function get_tabs() {
        return array(
            'general' => __('General', 'kelbe-project-tracker'),
            'trade_types' => __('Trade Types', 'kelbe-project-tracker'),
            'notifications' => __('Notifications', 'kelbe-project-tracker'),
            'ai_reports' => __('AI Reports', 'kelbe-project-tracker'),
            'permissions' => __('Permissions', 'kelbe-project-tracker'),
            'bid_items' => __('Bid Line Items', 'kelbe-project-tracker'),
            'proposals' => __('Proposals', 'kelbe-project-tracker'),
            'lead_integration' => __('Lead Integration', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Render General tab
     *
     * @param array $settings Current settings
     */
    private function render_general_tab($settings) {
        $company_name = isset($settings['company_name']) ? $settings['company_name'] : '';
        $company_email = isset($settings['company_email']) ? $settings['company_email'] : '';
        $company_phone = isset($settings['company_phone']) ? $settings['company_phone'] : '';
        $company_logo = isset($settings['company_logo']) ? $settings['company_logo'] : '';
        ?>
        <table class="form-table">
            <tr>
                <th scope="row">
                    <label for="company_name"><?php _e('Company Name', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="text" id="company_name" name="kpt_settings[company_name]" 
                           value="<?php echo esc_attr($company_name); ?>" class="regular-text">
                </td>
            </tr>
            <tr>
                <th scope="row">
                    <label for="company_email"><?php _e('Company Email', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="email" id="company_email" name="kpt_settings[company_email]" 
                           value="<?php echo esc_attr($company_email); ?>" class="regular-text">
                    <p class="description"><?php _e('Default email for notifications', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th scope="row">
                    <label for="company_phone"><?php _e('Company Phone', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="tel" id="company_phone" name="kpt_settings[company_phone]" 
                           value="<?php echo esc_attr($company_phone); ?>" class="regular-text">
                </td>
            </tr>
            <tr>
                <th scope="row">
                    <label for="company_logo"><?php _e('Company Logo', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <div id="logo-preview">
                        <?php if ($company_logo): ?>
                            <img src="<?php echo esc_url($company_logo); ?>" style="max-width: 200px; height: auto;">
                        <?php endif; ?>
                    </div>
                    <input type="hidden" id="company_logo" name="kpt_settings[company_logo]" 
                           value="<?php echo esc_attr($company_logo); ?>">
                    <button type="button" class="button" id="upload-logo-btn">
                        <?php _e('Upload Logo', 'kelbe-project-tracker'); ?>
                    </button>
                    <?php if ($company_logo): ?>
                        <button type="button" class="button" id="remove-logo-btn">
                            <?php _e('Remove Logo', 'kelbe-project-tracker'); ?>
                        </button>
                    <?php endif; ?>
                </td>
            </tr>
        </table>
        <?php
    }
    
    /**
     * Render Trade Types tab
     *
     * @param array $settings Current settings
     */
    private function render_trade_types_tab($settings) {
        $trade_types = isset($settings['trade_types']) ? $settings['trade_types'] : $this->get_default_trade_types();
        ?>
        <div class="kpt-trade-types-section">
            <p><?php _e('Manage trade types for your business. Drag to reorder.', 'kelbe-project-tracker'); ?></p>
            
            <div id="trade-types-list" class="kpt-sortable-list">
                <?php foreach ($trade_types as $index => $trade_type): ?>
                    <div class="trade-type-item" data-index="<?php echo esc_attr($index); ?>">
                        <span class="dashicons dashicons-menu handle"></span>
                        <input type="text" name="kpt_settings[trade_types][<?php echo esc_attr($index); ?>][name]" 
                               value="<?php echo esc_attr($trade_type['name']); ?>" placeholder="<?php _e('Trade Type Name', 'kelbe-project-tracker'); ?>">
                        <input type="text" name="kpt_settings[trade_types][<?php echo esc_attr($index); ?>][icon]" 
                               value="<?php echo esc_attr($trade_type['icon']); ?>" placeholder="<?php _e('Icon (dashicon name)', 'kelbe-project-tracker'); ?>" class="small-text">
                        <input type="text" name="kpt_settings[trade_types][<?php echo esc_attr($index); ?>][color]" 
                               value="<?php echo esc_attr($trade_type['color']); ?>" class="color-picker">
                        <button type="button" class="button remove-trade-type"><?php _e('Remove', 'kelbe-project-tracker'); ?></button>
                    </div>
                <?php endforeach; ?>
            </div>
            
            <button type="button" class="button" id="add-trade-type"><?php _e('Add Trade Type', 'kelbe-project-tracker'); ?></button>
        </div>
        <?php
    }
    
    /**
     * Render Notifications tab
     *
     * @param array $settings Current settings
     */
    private function render_notifications_tab($settings) {
        $notifications = isset($settings['notifications']) ? $settings['notifications'] : $this->get_default_notifications();
        ?>
        <table class="form-table">
            <?php foreach ($notifications as $key => $notification): ?>
                <tr>
                    <th scope="row">
                        <label for="notification_<?php echo esc_attr($key); ?>">
                            <?php echo esc_html($notification['label']); ?>
                        </label>
                    </th>
                    <td>
                        <label>
                            <input type="checkbox" id="notification_<?php echo esc_attr($key); ?>" 
                                   name="kpt_settings[notifications][<?php echo esc_attr($key); ?>][enabled]" 
                                   value="1" <?php checked($notification['enabled'], true); ?>>
                            <?php _e('Enable email notifications', 'kelbe-project-tracker'); ?>
                        </label>
                        <p class="description"><?php echo esc_html($notification['description']); ?></p>
                    </td>
                </tr>
            <?php endforeach; ?>
        </table>
        <?php
    }
    
    /**
     * Render AI Reports tab
     *
     * @param array $settings Current settings
     */
    private function render_ai_reports_tab($settings) {
        $ai_enabled = isset($settings['ai_enabled']) ? $settings['ai_enabled'] : false;
        $gemini_api_key = isset($settings['gemini_api_key']) ? $settings['gemini_api_key'] : '';
        ?>
        <table class="form-table">
            <tr>
                <th scope="row">
                    <label for="ai_enabled"><?php _e('Enable AI Reports', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <label>
                        <input type="checkbox" id="ai_enabled" name="kpt_settings[ai_enabled]" 
                               value="1" <?php checked($ai_enabled, true); ?>>
                        <?php _e('Enable AI-powered report generation', 'kelbe-project-tracker'); ?>
                    </label>
                    <p class="description"><?php _e('Uses Google Gemini API to generate intelligent project reports', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th scope="row">
                    <label for="gemini_api_key"><?php _e('Gemini API Key', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="password" id="gemini_api_key" name="kpt_settings[gemini_api_key]" 
                           value="<?php echo esc_attr($gemini_api_key); ?>" class="regular-text">
                    <p class="description">
                        <?php printf(
                            __('Get your API key from %s', 'kelbe-project-tracker'),
                            '<a href="https://makersuite.google.com/app/apikey" target="_blank">Google AI Studio</a>'
                        ); ?>
                    </p>
                    <p class="description"><?php _e('Note: AI report generation is currently in development', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
        </table>
        <?php
    }
    
    /**
     * Render Permissions tab
     *
     * @param array $settings Current settings
     */
    private function render_permissions_tab($settings) {
        $permissions = isset($settings['permissions']) ? $settings['permissions'] : $this->get_default_permissions();
        $roles = $this->get_roles();
        $capabilities = $this->get_capabilities();
        ?>
        <div class="kpt-permissions-section">
            <p><?php _e('Configure default permissions for each role', 'kelbe-project-tracker'); ?></p>
            
            <table class="wp-list-table widefat fixed striped">
                <thead>
                    <tr>
                        <th><?php _e('Capability', 'kelbe-project-tracker'); ?></th>
                        <?php foreach ($roles as $role_id => $role_name): ?>
                            <th><?php echo esc_html($role_name); ?></th>
                        <?php endforeach; ?>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($capabilities as $cap_id => $cap_name): ?>
                        <tr>
                            <td><strong><?php echo esc_html($cap_name); ?></strong></td>
                            <?php foreach ($roles as $role_id => $role_name): ?>
                                <td>
                                    <input type="checkbox" 
                                           name="kpt_settings[permissions][<?php echo esc_attr($role_id); ?>][<?php echo esc_attr($cap_id); ?>]" 
                                           value="1" 
                                           <?php checked(isset($permissions[$role_id][$cap_id]) && $permissions[$role_id][$cap_id], true); ?>>
                                </td>
                            <?php endforeach; ?>
                        </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
        </div>
        <?php
    }
    
    /**
     * Render Bid Line Items tab
     *
     * @param array $settings Current settings
     */
    private function render_bid_items_tab($settings) {
        $bid_items = isset($settings['bid_items']) ? $settings['bid_items'] : $this->get_default_bid_items();
        $trade_types = isset($settings['trade_types']) ? $settings['trade_types'] : $this->get_default_trade_types();
        ?>
        <div class="kpt-bid-items-section">
            <p><?php _e('Configure required bid line items per trade type', 'kelbe-project-tracker'); ?></p>
            
            <?php foreach ($trade_types as $index => $trade_type): ?>
                <div class="trade-type-bid-items">
                    <h3><?php echo esc_html($trade_type['name']); ?></h3>
                    
                    <div class="bid-items-list">
                        <?php
                        $items = isset($bid_items[$index]) ? $bid_items[$index] : array();
                        foreach ($items as $item_index => $item):
                        ?>
                            <div class="bid-item">
                                <input type="text" 
                                       name="kpt_settings[bid_items][<?php echo esc_attr($index); ?>][<?php echo esc_attr($item_index); ?>][name]" 
                                       value="<?php echo esc_attr($item['name']); ?>" 
                                       placeholder="<?php _e('Item Name', 'kelbe-project-tracker'); ?>">
                                <select name="kpt_settings[bid_items][<?php echo esc_attr($index); ?>][<?php echo esc_attr($item_index); ?>][required]">
                                    <option value="0" <?php selected($item['required'], false); ?>><?php _e('Optional', 'kelbe-project-tracker'); ?></option>
                                    <option value="1" <?php selected($item['required'], true); ?>><?php _e('Required', 'kelbe-project-tracker'); ?></option>
                                </select>
                                <button type="button" class="button remove-bid-item"><?php _e('Remove', 'kelbe-project-tracker'); ?></button>
                            </div>
                        <?php endforeach; ?>
                    </div>
                    
                    <button type="button" class="button add-bid-item" data-trade-type="<?php echo esc_attr($index); ?>">
                        <?php _e('Add Item', 'kelbe-project-tracker'); ?>
                    </button>
                </div>
            <?php endforeach; ?>
        </div>
        <?php
    }
    
    /**
     * Render Proposals tab
     *
     * @param array $settings Current settings
     */
    private function render_proposals_tab($settings) {
        $tax_rate = isset($settings['tax_rate']) ? $settings['tax_rate'] : 13;
        $deposit_percentage = isset($settings['deposit_percentage']) ? $settings['deposit_percentage'] : 30;
        $terms_conditions = isset($settings['terms_conditions']) ? $settings['terms_conditions'] : '';
        ?>
        <table class="form-table">
            <tr>
                <th scope="row">
                    <label for="tax_rate"><?php _e('Tax Rate (%)', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="number" id="tax_rate" name="kpt_settings[tax_rate]" 
                           value="<?php echo esc_attr($tax_rate); ?>" 
                           min="0" max="100" step="0.01" class="small-text">
                    <p class="description"><?php _e('Default tax rate for proposals', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th scope="row">
                    <label for="deposit_percentage"><?php _e('Deposit Percentage (%)', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <input type="number" id="deposit_percentage" name="kpt_settings[deposit_percentage]" 
                           value="<?php echo esc_attr($deposit_percentage); ?>" 
                           min="0" max="100" step="1" class="small-text">
                    <p class="description"><?php _e('Default deposit percentage for proposals', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
            <tr>
                <th scope="row">
                    <label for="terms_conditions"><?php _e('Terms & Conditions', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <?php
                    wp_editor($terms_conditions, 'terms_conditions', array(
                        'textarea_name' => 'kpt_settings[terms_conditions]',
                        'textarea_rows' => 10,
                        'media_buttons' => false,
                        'teeny' => true
                    ));
                    ?>
                    <p class="description"><?php _e('Default terms and conditions text for proposals', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
        </table>
        <?php
    }
    
    /**
     * Render Lead Integration tab
     *
     * @param array $settings Current settings
     */
    private function render_lead_integration_tab($settings) {
        $cf7_forms = $this->get_cf7_forms();
        $selected_form = isset($settings['cf7_form_id']) ? $settings['cf7_form_id'] : '';
        $field_mapping = isset($settings['cf7_field_mapping']) ? $settings['cf7_field_mapping'] : $this->get_default_field_mapping();
        ?>
        <table class="form-table">
            <tr>
                <th scope="row">
                    <label for="cf7_form_id"><?php _e('Contact Form 7', 'kelbe-project-tracker'); ?></label>
                </th>
                <td>
                    <select id="cf7_form_id" name="kpt_settings[cf7_form_id]" class="regular-text">
                        <option value=""><?php _e('Select a form', 'kelbe-project-tracker'); ?></option>
                        <?php foreach ($cf7_forms as $form): ?>
                            <option value="<?php echo esc_attr($form->ID); ?>" <?php selected($selected_form, $form->ID); ?>>
                                <?php echo esc_html($form->post_title); ?>
                            </option>
                        <?php endforeach; ?>
                    </select>
                    <p class="description"><?php _e('Select the Contact Form 7 form to integrate with leads', 'kelbe-project-tracker'); ?></p>
                </td>
            </tr>
        </table>
        
        <?php if (!empty($cf7_forms)): ?>
            <h3><?php _e('Field Mapping', 'kelbe-project-tracker'); ?></h3>
            <table class="form-table">
                <?php
                $lead_fields = array(
                    'name' => __('Name', 'kelbe-project-tracker'),
                    'email' => __('Email', 'kelbe-project-tracker'),
                    'phone' => __('Phone', 'kelbe-project-tracker'),
                    'address' => __('Address', 'kelbe-project-tracker'),
                    'project_type' => __('Project Type', 'kelbe-project-tracker'),
                    'budget' => __('Budget', 'kelbe-project-tracker'),
                    'message' => __('Message', 'kelbe-project-tracker')
                );
                
                foreach ($lead_fields as $field_key => $field_label):
                ?>
                    <tr>
                        <th scope="row">
                            <label for="field_<?php echo esc_attr($field_key); ?>">
                                <?php echo esc_html($field_label); ?>
                            </label>
                        </th>
                        <td>
                            <input type="text" 
                                   id="field_<?php echo esc_attr($field_key); ?>" 
                                   name="kpt_settings[cf7_field_mapping][<?php echo esc_attr($field_key); ?>]" 
                                   value="<?php echo esc_attr(isset($field_mapping[$field_key]) ? $field_mapping[$field_key] : ''); ?>" 
                                   class="regular-text" 
                                   placeholder="<?php _e('CF7 field name', 'kelbe-project-tracker'); ?>">
                            <p class="description">
                                <?php _e('Enter the Contact Form 7 field name (e.g., your-name, your-email)', 'kelbe-project-tracker'); ?>
                            </p>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </table>
        <?php endif; ?>
        <?php
    }
    
    /**
     * AJAX save settings
     */
    public function ajax_save_settings() {
        check_ajax_referer('kpt_settings_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(array('message' => __('Permission denied', 'kelbe-project-tracker')));
        }
        
        $settings = isset($_POST['settings']) ? $_POST['settings'] : array();
        $sanitized_settings = $this->sanitize_settings($settings);
        
        update_option($this->option_name, $sanitized_settings);
        
        wp_send_json_success(array('message' => __('Settings saved successfully', 'kelbe-project-tracker')));
    }
    
    /**
     * AJAX upload logo
     */
    public function ajax_upload_logo() {
        check_ajax_referer('kpt_settings_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(array('message' => __('Permission denied', 'kelbe-project-tracker')));
        }
        
        if (empty($_FILES['file'])) {
            wp_send_json_error(array('message' => __('No file uploaded', 'kelbe-project-tracker')));
        }
        
        require_once(ABSPATH . 'wp-admin/includes/file.php');
        require_once(ABSPATH . 'wp-admin/includes/media.php');
        require_once(ABSPATH . 'wp-admin/includes/image.php');
        
        $attachment_id = media_handle_upload('file', 0);
        
        if (is_wp_error($attachment_id)) {
            wp_send_json_error(array('message' => $attachment_id->get_error_message()));
        }
        
        $logo_url = wp_get_attachment_url($attachment_id);
        
        wp_send_json_success(array('url' => $logo_url));
    }
    
    /**
     * Get settings
     *
     * @return array
     */
    public function get_settings() {
        $defaults = array(
            'company_name' => '',
            'company_email' => get_option('admin_email'),
            'company_phone' => '',
            'company_logo' => '',
            'trade_types' => $this->get_default_trade_types(),
            'notifications' => $this->get_default_notifications(),
            'ai_enabled' => false,
            'gemini_api_key' => '',
            'permissions' => $this->get_default_permissions(),
            'bid_items' => $this->get_default_bid_items(),
            'tax_rate' => 13,
            'deposit_percentage' => 30,
            'terms_conditions' => '',
            'cf7_form_id' => '',
            'cf7_field_mapping' => $this->get_default_field_mapping()
        );
        
        $settings = get_option($this->option_name, array());
        
        return wp_parse_args($settings, $defaults);
    }
    
    /**
     * Sanitize settings
     *
     * @param array $settings Raw settings
     * @return array Sanitized settings
     */
    public function sanitize_settings($settings) {
        $sanitized = array();
        
        // General
        if (isset($settings['company_name'])) {
            $sanitized['company_name'] = sanitize_text_field($settings['company_name']);
        }
        if (isset($settings['company_email'])) {
            $sanitized['company_email'] = sanitize_email($settings['company_email']);
        }
        if (isset($settings['company_phone'])) {
            $sanitized['company_phone'] = sanitize_text_field($settings['company_phone']);
        }
        if (isset($settings['company_logo'])) {
            $sanitized['company_logo'] = esc_url_raw($settings['company_logo']);
        }
        
        // Trade types
        if (isset($settings['trade_types']) && is_array($settings['trade_types'])) {
            $sanitized['trade_types'] = array();
            foreach ($settings['trade_types'] as $trade_type) {
                if (isset($trade_type['name']) && !empty($trade_type['name'])) {
                    $sanitized['trade_types'][] = array(
                        'name' => sanitize_text_field($trade_type['name']),
                        'icon' => isset($trade_type['icon']) ? sanitize_text_field($trade_type['icon']) : 'dashicons-hammer',
                        'color' => isset($trade_type['color']) ? sanitize_hex_color($trade_type['color']) : '#0073aa'
                    );
                }
            }
        }
        
        // Notifications
        if (isset($settings['notifications']) && is_array($settings['notifications'])) {
            $sanitized['notifications'] = array();
            foreach ($settings['notifications'] as $key => $value) {
                $sanitized['notifications'][$key] = array(
                    'enabled' => isset($value['enabled']) && $value['enabled'] == '1'
                );
            }
        }
        
        // AI
        if (isset($settings['ai_enabled'])) {
            $sanitized['ai_enabled'] = (bool) $settings['ai_enabled'];
        }
        if (isset($settings['gemini_api_key'])) {
            $sanitized['gemini_api_key'] = sanitize_text_field($settings['gemini_api_key']);
        }
        
        // Permissions
        if (isset($settings['permissions']) && is_array($settings['permissions'])) {
            $sanitized['permissions'] = array();
            foreach ($settings['permissions'] as $role => $caps) {
                foreach ($caps as $cap => $value) {
                    $sanitized['permissions'][$role][$cap] = (bool) $value;
                }
            }
        }
        
        // Bid items
        if (isset($settings['bid_items']) && is_array($settings['bid_items'])) {
            $sanitized['bid_items'] = array();
            foreach ($settings['bid_items'] as $trade_index => $items) {
                if (is_array($items)) {
                    foreach ($items as $item) {
                        if (isset($item['name']) && !empty($item['name'])) {
                            $sanitized['bid_items'][$trade_index][] = array(
                                'name' => sanitize_text_field($item['name']),
                                'required' => isset($item['required']) && $item['required'] == '1'
                            );
                        }
                    }
                }
            }
        }
        
        // Proposals
        if (isset($settings['tax_rate'])) {
            $sanitized['tax_rate'] = floatval($settings['tax_rate']);
        }
        if (isset($settings['deposit_percentage'])) {
            $sanitized['deposit_percentage'] = absint($settings['deposit_percentage']);
        }
        if (isset($settings['terms_conditions'])) {
            $sanitized['terms_conditions'] = wp_kses_post($settings['terms_conditions']);
        }
        
        // Lead integration
        if (isset($settings['cf7_form_id'])) {
            $sanitized['cf7_form_id'] = absint($settings['cf7_form_id']);
        }
        if (isset($settings['cf7_field_mapping']) && is_array($settings['cf7_field_mapping'])) {
            $sanitized['cf7_field_mapping'] = array();
            foreach ($settings['cf7_field_mapping'] as $key => $value) {
                $sanitized['cf7_field_mapping'][$key] = sanitize_text_field($value);
            }
        }
        
        return $sanitized;
    }
    
    /**
     * Get default trade types
     *
     * @return array
     */
    private function get_default_trade_types() {
        return array(
            array('name' => 'General Contractor', 'icon' => 'dashicons-hammer', 'color' => '#0073aa'),
            array('name' => 'Plumbing', 'icon' => 'dashicons-admin-tools', 'color' => '#00a0d2'),
            array('name' => 'Electrical', 'icon' => 'dashicons-lightbulb', 'color' => '#f0b849'),
            array('name' => 'HVAC', 'icon' => 'dashicons-admin-settings', 'color' => '#826eb4'),
            array('name' => 'Carpentry', 'icon' => 'dashicons-image-filter', 'color' => '#d54e21')
        );
    }
    
    /**
     * Get default notifications
     *
     * @return array
     */
    private function get_default_notifications() {
        return array(
            'new_lead' => array(
                'label' => __('New Lead', 'kelbe-project-tracker'),
                'description' => __('Notify when a new lead is created', 'kelbe-project-tracker'),
                'enabled' => true
            ),
            'bid_submitted' => array(
                'label' => __('Bid Submitted', 'kelbe-project-tracker'),
                'description' => __('Notify when a bid is submitted', 'kelbe-project-tracker'),
                'enabled' => true
            ),
            'bid_accepted' => array(
                'label' => __('Bid Accepted', 'kelbe-project-tracker'),
                'description' => __('Notify when a bid is accepted', 'kelbe-project-tracker'),
                'enabled' => true
            ),
            'proposal_sent' => array(
                'label' => __('Proposal Sent', 'kelbe-project-tracker'),
                'description' => __('Notify when a proposal is sent to client', 'kelbe-project-tracker'),
                'enabled' => true
            ),
            'proposal_signed' => array(
                'label' => __('Proposal Signed', 'kelbe-project-tracker'),
                'description' => __('Notify when a proposal is signed', 'kelbe-project-tracker'),
                'enabled' => true
            ),
            'task_assigned' => array(
                'label' => __('Task Assigned', 'kelbe-project-tracker'),
                'description' => __('Notify when a task is assigned to a user', 'kelbe-project-tracker'),
                'enabled' => true
            )
        );
    }
    
    /**
     * Get roles
     *
     * @return array
     */
    private function get_roles() {
        return array(
            'administrator' => __('Administrator', 'kelbe-project-tracker'),
            'project_manager' => __('Project Manager', 'kelbe-project-tracker'),
            'contractor' => __('Contractor', 'kelbe-project-tracker'),
            'client' => __('Client', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Get capabilities
     *
     * @return array
     */
    private function get_capabilities() {
        return array(
            'view_projects' => __('View Projects', 'kelbe-project-tracker'),
            'edit_projects' => __('Edit Projects', 'kelbe-project-tracker'),
            'delete_projects' => __('Delete Projects', 'kelbe-project-tracker'),
            'manage_bids' => __('Manage Bids', 'kelbe-project-tracker'),
            'view_budget' => __('View Budget', 'kelbe-project-tracker'),
            'edit_budget' => __('Edit Budget', 'kelbe-project-tracker'),
            'view_proposals' => __('View Proposals', 'kelbe-project-tracker'),
            'create_proposals' => __('Create Proposals', 'kelbe-project-tracker'),
            'manage_leads' => __('Manage Leads', 'kelbe-project-tracker'),
            'manage_team' => __('Manage Team', 'kelbe-project-tracker')
        );
    }
    
    /**
     * Get default permissions
     *
     * @return array
     */
    private function get_default_permissions() {
        return array(
            'administrator' => array(
                'view_projects' => true,
                'edit_projects' => true,
                'delete_projects' => true,
                'manage_bids' => true,
                'view_budget' => true,
                'edit_budget' => true,
                'view_proposals' => true,
                'create_proposals' => true,
                'manage_leads' => true,
                'manage_team' => true
            ),
            'project_manager' => array(
                'view_projects' => true,
                'edit_projects' => true,
                'delete_projects' => false,
                'manage_bids' => true,
                'view_budget' => true,
                'edit_budget' => true,
                'view_proposals' => true,
                'create_proposals' => true,
                'manage_leads' => true,
                'manage_team' => false
            ),
            'contractor' => array(
                'view_projects' => true,
                'edit_projects' => false,
                'delete_projects' => false,
                'manage_bids' => true,
                'view_budget' => false,
                'edit_budget' => false,
                'view_proposals' => false,
                'create_proposals' => false,
                'manage_leads' => false,
                'manage_team' => false
            ),
            'client' => array(
                'view_projects' => true,
                'edit_projects' => false,
                'delete_projects' => false,
                'manage_bids' => false,
                'view_budget' => false,
                'edit_budget' => false,
                'view_proposals' => true,
                'create_proposals' => false,
                'manage_leads' => false,
                'manage_team' => false
            )
        );
    }
    
    /**
     * Get default bid items
     *
     * @return array
     */
    private function get_default_bid_items() {
        return array();
    }
    
    /**
     * Get default field mapping
     *
     * @return array
     */
    private function get_default_field_mapping() {
        return array(
            'name' => 'your-name',
            'email' => 'your-email',
            'phone' => 'your-phone',
            'address' => 'your-address',
            'project_type' => 'project-type',
            'budget' => 'budget',
            'message' => 'your-message'
        );
    }
    
    /**
     * Get Contact Form 7 forms
     *
     * @return array
     */
    private function get_cf7_forms() {
        if (!function_exists('wpcf7')) {
            return array();
        }
        
        $args = array(
            'post_type' => 'wpcf7_contact_form',
            'posts_per_page' => -1,
            'orderby' => 'title',
            'order' => 'ASC'
        );
        
        return get_posts($args);
    }
}

// Initialize
KPT_Admin_Settings::get_instance();
