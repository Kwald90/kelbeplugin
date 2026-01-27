<?php
/**
 * Lead Handler
 *
 * Lead management and Contact Form 7 integration
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Lead Handler class
 */
class KPT_Lead_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Lead_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Lead_Handler
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
        // Contact Form 7 integration
        add_action('wpcf7_before_send_mail', array($this, 'capture_cf7_submission'));
        
        // AJAX handlers
        add_action('wp_ajax_kpt_create_lead', array($this, 'ajax_create_lead'));
        add_action('wp_ajax_kpt_update_lead', array($this, 'ajax_update_lead'));
        add_action('wp_ajax_kpt_delete_lead', array($this, 'ajax_delete_lead'));
        add_action('wp_ajax_kpt_convert_lead', array($this, 'ajax_convert_lead'));
        add_action('wp_ajax_kpt_assign_lead', array($this, 'ajax_assign_lead'));
        add_action('wp_ajax_kpt_get_leads', array($this, 'ajax_get_leads'));
    }
    
    /**
     * Get leads
     *
     * @param array $args Query arguments
     * @return array Leads
     */
    public function get_leads($args = array()) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_leads';
        
        $defaults = array(
            'status' => null,
            'stage' => null,
            'assigned_to' => null,
            'order_by' => 'created_at',
            'order' => 'DESC',
            'limit' => 50,
            'offset' => 0,
        );
        
        $args = wp_parse_args($args, $defaults);
        
        $where = array('1=1');
        
        if ($args['status']) {
            $where[] = $wpdb->prepare('status = %s', $args['status']);
        }
        
        if ($args['stage']) {
            $where[] = $wpdb->prepare('stage = %s', $args['stage']);
        }
        
        if ($args['assigned_to']) {
            $where[] = $wpdb->prepare('assigned_to = %d', $args['assigned_to']);
        }
        
        $sql = sprintf(
            "SELECT * FROM $table WHERE %s ORDER BY %s %s LIMIT %d OFFSET %d",
            implode(' AND ', $where),
            sanitize_sql_orderby($args['order_by']),
            $args['order'] === 'ASC' ? 'ASC' : 'DESC',
            absint($args['limit']),
            absint($args['offset'])
        );
        
        $leads = $wpdb->get_results($sql);
        
        // Enrich with assigned user data
        foreach ($leads as &$lead) {
            if ($lead->assigned_to) {
                $user = get_userdata($lead->assigned_to);
                if ($user) {
                    $lead->assigned_to_name = $user->display_name;
                }
            }
        }
        
        return $leads;
    }
    
    /**
     * Get a single lead
     *
     * @param int $lead_id Lead ID
     * @return object|null Lead object or null
     */
    public function get_lead($lead_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_leads';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $lead_id));
    }
    
    /**
     * Create a lead
     *
     * @param array $data Lead data
     * @return int|false Lead ID on success, false on failure
     */
    public function create_lead($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_leads';
        
        $defaults = array(
            'first_name' => '',
            'last_name' => '',
            'email' => '',
            'phone' => '',
            'address' => '',
            'city' => '',
            'province' => '',
            'postal_code' => '',
            'project_type' => '',
            'project_description' => '',
            'estimated_budget' => null,
            'timeline' => '',
            'source' => '',
            'utm_source' => '',
            'utm_medium' => '',
            'utm_campaign' => '',
            'status' => 'new',
            'stage' => 'inquiry',
            'priority' => 'medium',
            'assigned_to' => null,
            'estimated_value' => null,
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'first_name' => sanitize_text_field($data['first_name']),
            'last_name' => sanitize_text_field($data['last_name']),
            'email' => sanitize_email($data['email']),
            'phone' => sanitize_text_field($data['phone']),
            'address' => sanitize_text_field($data['address']),
            'city' => sanitize_text_field($data['city']),
            'province' => sanitize_text_field($data['province']),
            'postal_code' => sanitize_text_field($data['postal_code']),
            'project_type' => sanitize_text_field($data['project_type']),
            'project_description' => sanitize_textarea_field($data['project_description']),
            'estimated_budget' => $data['estimated_budget'] ? floatval($data['estimated_budget']) : null,
            'timeline' => sanitize_text_field($data['timeline']),
            'source' => sanitize_text_field($data['source']),
            'utm_source' => sanitize_text_field($data['utm_source']),
            'utm_medium' => sanitize_text_field($data['utm_medium']),
            'utm_campaign' => sanitize_text_field($data['utm_campaign']),
            'status' => sanitize_text_field($data['status']),
            'stage' => sanitize_text_field($data['stage']),
            'priority' => sanitize_text_field($data['priority']),
            'assigned_to' => $data['assigned_to'] ? absint($data['assigned_to']) : null,
            'estimated_value' => $data['estimated_value'] ? floatval($data['estimated_value']) : null,
            'created_at' => current_time('mysql'),
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $lead_id = $wpdb->insert_id;
        
        do_action('kpt_lead_created', $lead_id, $data);
        
        // Send notification
        $this->send_lead_notification($lead_id);
        
        return $lead_id;
    }
    
    /**
     * Update a lead
     *
     * @param int $lead_id Lead ID
     * @param array $data Lead data
     * @return bool True on success, false on failure
     */
    public function update_lead($lead_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_leads';
        
        $lead = $this->get_lead($lead_id);
        if (!$lead) {
            return false;
        }
        
        $update_data = array();
        
        $allowed_fields = array(
            'first_name', 'last_name', 'email', 'phone', 'address', 'city', 
            'province', 'postal_code', 'project_type', 'project_description',
            'estimated_budget', 'timeline', 'source', 'status', 'stage', 
            'priority', 'assigned_to', 'estimated_value'
        );
        
        foreach ($allowed_fields as $field) {
            if (isset($data[$field])) {
                if (in_array($field, array('estimated_budget', 'estimated_value'))) {
                    $update_data[$field] = $data[$field] ? floatval($data[$field]) : null;
                } elseif ($field === 'assigned_to') {
                    $update_data[$field] = $data[$field] ? absint($data[$field]) : null;
                } elseif ($field === 'email') {
                    $update_data[$field] = sanitize_email($data[$field]);
                } elseif ($field === 'project_description') {
                    $update_data[$field] = sanitize_textarea_field($data[$field]);
                } else {
                    $update_data[$field] = sanitize_text_field($data[$field]);
                }
            }
        }
        
        if (empty($update_data)) {
            return false;
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $lead_id));
        
        if ($result !== false) {
            do_action('kpt_lead_updated', $lead_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a lead
     *
     * @param int $lead_id Lead ID
     * @return bool True on success, false on failure
     */
    public function delete_lead($lead_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_leads';
        
        $lead = $this->get_lead($lead_id);
        if (!$lead) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $lead_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_lead_deleted', $lead_id, $lead);
        }
        
        return $result !== false;
    }
    
    /**
     * Convert lead to project
     *
     * @param int $lead_id Lead ID
     * @return int|false Project ID on success, false on failure
     */
    public function convert_to_project($lead_id) {
        global $wpdb;
        
        $lead = $this->get_lead($lead_id);
        if (!$lead) {
            return false;
        }
        
        // Create project
        $project_title = $lead->project_type . ' - ' . $lead->first_name . ' ' . $lead->last_name;
        
        $project_id = wp_insert_post(array(
            'post_title' => $project_title,
            'post_content' => $lead->project_description,
            'post_status' => 'publish',
            'post_type' => 'kpt_project',
            'post_author' => get_current_user_id(),
        ));
        
        if (is_wp_error($project_id)) {
            return false;
        }
        
        // Save project meta
        update_post_meta($project_id, '_kpt_client_name', $lead->first_name . ' ' . $lead->last_name);
        update_post_meta($project_id, '_kpt_client_email', $lead->email);
        update_post_meta($project_id, '_kpt_client_phone', $lead->phone);
        update_post_meta($project_id, '_kpt_client_address', $lead->address . ', ' . $lead->city . ', ' . $lead->province . ' ' . $lead->postal_code);
        update_post_meta($project_id, '_kpt_project_type', $lead->project_type);
        update_post_meta($project_id, '_kpt_project_budget', $lead->estimated_budget);
        update_post_meta($project_id, '_kpt_project_stage', 1);
        
        // Update lead
        $table = $wpdb->prefix . 'kpt_leads';
        $wpdb->update(
            $table,
            array(
                'status' => 'converted',
                'stage' => 'won',
                'converted_to_project' => $project_id,
                'converted_at' => current_time('mysql'),
            ),
            array('id' => $lead_id)
        );
        
        do_action('kpt_lead_converted', $lead_id, $project_id);
        
        return $project_id;
    }
    
    /**
     * Capture Contact Form 7 submission
     *
     * @param object $contact_form CF7 form object
     */
    public function capture_cf7_submission($contact_form) {
        $submission = WPCF7_Submission::get_instance();
        
        if (!$submission) {
            return;
        }
        
        $posted_data = $submission->get_posted_data();
        
        // Map CF7 fields to lead fields
        $lead_data = array(
            'first_name' => isset($posted_data['first-name']) ? $posted_data['first-name'] : '',
            'last_name' => isset($posted_data['last-name']) ? $posted_data['last-name'] : '',
            'email' => isset($posted_data['email']) ? $posted_data['email'] : '',
            'phone' => isset($posted_data['phone']) ? $posted_data['phone'] : '',
            'address' => isset($posted_data['address']) ? $posted_data['address'] : '',
            'city' => isset($posted_data['city']) ? $posted_data['city'] : '',
            'province' => isset($posted_data['province']) ? $posted_data['province'] : '',
            'postal_code' => isset($posted_data['postal-code']) ? $posted_data['postal-code'] : '',
            'project_type' => isset($posted_data['project-type']) ? $posted_data['project-type'] : '',
            'project_description' => isset($posted_data['message']) ? $posted_data['message'] : '',
            'source' => 'Contact Form 7',
        );
        
        // Capture UTM parameters
        if (isset($_COOKIE['utm_source'])) {
            $lead_data['utm_source'] = sanitize_text_field($_COOKIE['utm_source']);
        }
        if (isset($_COOKIE['utm_medium'])) {
            $lead_data['utm_medium'] = sanitize_text_field($_COOKIE['utm_medium']);
        }
        if (isset($_COOKIE['utm_campaign'])) {
            $lead_data['utm_campaign'] = sanitize_text_field($_COOKIE['utm_campaign']);
        }
        
        // Create lead
        $this->create_lead($lead_data);
    }
    
    /**
     * Send lead notification
     *
     * @param int $lead_id Lead ID
     */
    private function send_lead_notification($lead_id) {
        $lead = $this->get_lead($lead_id);
        if (!$lead) {
            return;
        }
        
        // Get admin email
        $admin_email = get_option('admin_email');
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        $notification_handler->send_notification(
            $admin_email,
            sprintf(__('New Lead: %s %s', 'kelbe-project-tracker'), $lead->first_name, $lead->last_name),
            'new_lead',
            array(
                'lead_id' => $lead_id,
                'first_name' => $lead->first_name,
                'last_name' => $lead->last_name,
                'email' => $lead->email,
                'phone' => $lead->phone,
                'project_type' => $lead->project_type,
                'project_description' => $lead->project_description,
            )
        );
    }
    
    /**
     * Get lead statistics
     *
     * @return array Statistics
     */
    public function get_statistics() {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_leads';
        
        $total = $wpdb->get_var("SELECT COUNT(*) FROM $table");
        $new = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $table WHERE status = %s", 'new'));
        $contacted = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $table WHERE status = %s", 'contacted'));
        $qualified = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $table WHERE status = %s", 'qualified'));
        $converted = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $table WHERE status = %s", 'converted'));
        
        $total_value = $wpdb->get_var("SELECT SUM(estimated_value) FROM $table WHERE status != 'lost'");
        
        return array(
            'total' => absint($total),
            'new' => absint($new),
            'contacted' => absint($contacted),
            'qualified' => absint($qualified),
            'converted' => absint($converted),
            'total_value' => $total_value ? floatval($total_value) : 0,
        );
    }
    
    /**
     * AJAX: Create lead
     */
    public function ajax_create_lead() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'first_name' => isset($_POST['first_name']) ? sanitize_text_field($_POST['first_name']) : '',
            'last_name' => isset($_POST['last_name']) ? sanitize_text_field($_POST['last_name']) : '',
            'email' => isset($_POST['email']) ? sanitize_email($_POST['email']) : '',
            'phone' => isset($_POST['phone']) ? sanitize_text_field($_POST['phone']) : '',
            'project_type' => isset($_POST['project_type']) ? sanitize_text_field($_POST['project_type']) : '',
            'project_description' => isset($_POST['project_description']) ? sanitize_textarea_field($_POST['project_description']) : '',
        );
        
        $lead_id = $this->create_lead($data);
        
        if ($lead_id) {
            wp_send_json_success(array(
                'message' => __('Lead created.', 'kelbe-project-tracker'),
                'lead_id' => $lead_id,
                'lead' => $this->get_lead($lead_id),
            ));
        } else {
            wp_send_json_error(__('Failed to create lead.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Update lead
     */
    public function ajax_update_lead() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $lead_id = isset($_POST['lead_id']) ? absint($_POST['lead_id']) : 0;
        
        $data = array();
        $allowed_fields = array(
            'first_name', 'last_name', 'email', 'phone', 'status', 
            'stage', 'priority', 'assigned_to', 'estimated_value'
        );
        
        foreach ($allowed_fields as $field) {
            if (isset($_POST[$field])) {
                $data[$field] = $_POST[$field];
            }
        }
        
        if ($this->update_lead($lead_id, $data)) {
            wp_send_json_success(array(
                'message' => __('Lead updated.', 'kelbe-project-tracker'),
                'lead' => $this->get_lead($lead_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update lead.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Delete lead
     */
    public function ajax_delete_lead() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $lead_id = isset($_POST['lead_id']) ? absint($_POST['lead_id']) : 0;
        
        if ($this->delete_lead($lead_id)) {
            wp_send_json_success(__('Lead deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete lead.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Convert lead
     */
    public function ajax_convert_lead() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $lead_id = isset($_POST['lead_id']) ? absint($_POST['lead_id']) : 0;
        
        $project_id = $this->convert_to_project($lead_id);
        
        if ($project_id) {
            wp_send_json_success(array(
                'message' => __('Lead converted to project.', 'kelbe-project-tracker'),
                'project_id' => $project_id,
                'project_url' => get_edit_post_link($project_id, 'raw'),
            ));
        } else {
            wp_send_json_error(__('Failed to convert lead.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Assign lead
     */
    public function ajax_assign_lead() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $lead_id = isset($_POST['lead_id']) ? absint($_POST['lead_id']) : 0;
        $user_id = isset($_POST['user_id']) ? absint($_POST['user_id']) : 0;
        
        if ($this->update_lead($lead_id, array('assigned_to' => $user_id))) {
            wp_send_json_success(__('Lead assigned.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to assign lead.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Get leads
     */
    public function ajax_get_leads() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        if (!current_user_can('manage_options')) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $args = array();
        
        if (isset($_POST['status'])) {
            $args['status'] = sanitize_text_field($_POST['status']);
        }
        
        if (isset($_POST['stage'])) {
            $args['stage'] = sanitize_text_field($_POST['stage']);
        }
        
        $leads = $this->get_leads($args);
        
        wp_send_json_success($leads);
    }
}
