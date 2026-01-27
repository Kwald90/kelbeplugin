<?php
/**
 * Bid Handler
 *
 * Handles the bidding system
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Bid Handler class
 */
class KPT_Bid_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Bid_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Bid_Handler
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
        add_action('wp_ajax_kpt_create_bid', array($this, 'ajax_create_bid'));
        add_action('wp_ajax_kpt_update_bid', array($this, 'ajax_update_bid'));
        add_action('wp_ajax_kpt_delete_bid', array($this, 'ajax_delete_bid'));
        add_action('wp_ajax_kpt_submit_bid', array($this, 'ajax_submit_bid'));
        add_action('wp_ajax_kpt_accept_bid', array($this, 'ajax_accept_bid'));
        add_action('wp_ajax_kpt_reject_bid', array($this, 'ajax_reject_bid'));
        add_action('wp_ajax_kpt_request_revision', array($this, 'ajax_request_revision'));
    }
    
    /**
     * Get bids for a project
     *
     * @param int $project_id Project ID
     * @param string $status Optional status filter
     * @param string $trade_type Optional trade type filter
     * @return array Bids
     */
    public function get_bids($project_id, $status = null, $trade_type = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $where = array($wpdb->prepare('project_id = %d', $project_id));
        
        if ($status !== null) {
            $where[] = $wpdb->prepare('status = %s', $status);
        }
        
        if ($trade_type !== null) {
            $where[] = $wpdb->prepare('trade_type = %s', $trade_type);
        }
        
        $sql = "SELECT * FROM $table WHERE " . implode(' AND ', $where) . " ORDER BY submitted_at DESC, id DESC";
        
        $bids = $wpdb->get_results($sql);
        
        // Enrich with user data and decode line items
        foreach ($bids as &$bid) {
            if ($bid->trade_user_id) {
                $user = get_userdata($bid->trade_user_id);
                if ($user) {
                    $bid->trade_user_name = $user->display_name;
                    $bid->trade_user_email = $user->user_email;
                }
            }
            
            // Decode line items
            if ($bid->line_items) {
                $bid->line_items_decoded = json_decode($bid->line_items, true);
            }
        }
        
        return $bids;
    }
    
    /**
     * Get a single bid
     *
     * @param int $bid_id Bid ID
     * @return object|null Bid object or null
     */
    public function get_bid($bid_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $bid_id));
        
        if ($bid && $bid->line_items) {
            $bid->line_items_decoded = json_decode($bid->line_items, true);
        }
        
        return $bid;
    }
    
    /**
     * Get bids for a trade user
     *
     * @param int $user_id User ID
     * @param string $status Optional status filter
     * @return array Bids
     */
    public function get_user_bids($user_id, $status = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $where = $wpdb->prepare('trade_user_id = %d', $user_id);
        
        if ($status !== null) {
            $where .= $wpdb->prepare(' AND status = %s', $status);
        }
        
        return $wpdb->get_results("SELECT * FROM $table WHERE $where ORDER BY submitted_at DESC, id DESC");
    }
    
    /**
     * Create a bid
     *
     * @param array $data Bid data
     * @return int|false Bid ID on success, false on failure
     */
    public function create_bid($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $defaults = array(
            'project_id' => 0,
            'trade_user_id' => get_current_user_id(),
            'trade_type' => '',
            'bid_number' => $this->generate_bid_number(),
            'line_items' => array(),
            'subtotal' => 0.00,
            'tax' => 0.00,
            'total' => 0.00,
            'status' => 'draft',
            'notes' => '',
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Calculate totals if line items provided
        if (!empty($data['line_items'])) {
            $totals = $this->calculate_totals($data['line_items']);
            $data['subtotal'] = $totals['subtotal'];
            $data['tax'] = $totals['tax'];
            $data['total'] = $totals['total'];
        }
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'trade_user_id' => absint($data['trade_user_id']),
            'trade_type' => sanitize_text_field($data['trade_type']),
            'bid_number' => sanitize_text_field($data['bid_number']),
            'line_items' => wp_json_encode($data['line_items']),
            'subtotal' => floatval($data['subtotal']),
            'tax' => floatval($data['tax']),
            'total' => floatval($data['total']),
            'status' => sanitize_text_field($data['status']),
            'notes' => sanitize_textarea_field($data['notes']),
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $bid_id = $wpdb->insert_id;
        
        do_action('kpt_bid_created', $bid_id, $data);
        
        return $bid_id;
    }
    
    /**
     * Update a bid
     *
     * @param int $bid_id Bid ID
     * @param array $data Bid data
     * @return bool True on success, false on failure
     */
    public function update_bid($bid_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        $update_data = array();
        
        if (isset($data['trade_type'])) {
            $update_data['trade_type'] = sanitize_text_field($data['trade_type']);
        }
        
        if (isset($data['line_items'])) {
            $update_data['line_items'] = wp_json_encode($data['line_items']);
            
            // Recalculate totals
            $totals = $this->calculate_totals($data['line_items']);
            $update_data['subtotal'] = $totals['subtotal'];
            $update_data['tax'] = $totals['tax'];
            $update_data['total'] = $totals['total'];
        }
        
        if (isset($data['notes'])) {
            $update_data['notes'] = sanitize_textarea_field($data['notes']);
        }
        
        if (isset($data['revision_notes'])) {
            $update_data['revision_notes'] = sanitize_textarea_field($data['revision_notes']);
        }
        
        if (isset($data['status'])) {
            $update_data['status'] = sanitize_text_field($data['status']);
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $bid_id));
        
        if ($result !== false) {
            do_action('kpt_bid_updated', $bid_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a bid
     *
     * @param int $bid_id Bid ID
     * @return bool True on success, false on failure
     */
    public function delete_bid($bid_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $bid_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_bid_deleted', $bid_id, $bid);
        }
        
        return $result !== false;
    }
    
    /**
     * Submit a bid
     *
     * @param int $bid_id Bid ID
     * @return bool True on success, false on failure
     */
    public function submit_bid($bid_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        $update_data = array(
            'status' => 'submitted',
            'submitted_at' => current_time('mysql'),
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $bid_id));
        
        if ($result !== false) {
            do_action('kpt_bid_submitted', $bid_id);
            
            // Send notification
            $this->send_bid_notification($bid_id, 'submitted');
        }
        
        return $result !== false;
    }
    
    /**
     * Accept a bid
     *
     * @param int $bid_id Bid ID
     * @param int $user_id User ID
     * @return bool True on success, false on failure
     */
    public function accept_bid($bid_id, $user_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        $update_data = array(
            'status' => 'accepted',
            'reviewed_at' => current_time('mysql'),
            'reviewed_by' => $user_id,
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $bid_id));
        
        if ($result !== false) {
            do_action('kpt_bid_accepted', $bid_id, $user_id);
            
            // Send notification
            $this->send_bid_notification($bid_id, 'accepted');
        }
        
        return $result !== false;
    }
    
    /**
     * Reject a bid
     *
     * @param int $bid_id Bid ID
     * @param int $user_id User ID
     * @return bool True on success, false on failure
     */
    public function reject_bid($bid_id, $user_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        $update_data = array(
            'status' => 'rejected',
            'reviewed_at' => current_time('mysql'),
            'reviewed_by' => $user_id,
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $bid_id));
        
        if ($result !== false) {
            do_action('kpt_bid_rejected', $bid_id, $user_id);
            
            // Send notification
            $this->send_bid_notification($bid_id, 'rejected');
        }
        
        return $result !== false;
    }
    
    /**
     * Request revision on a bid
     *
     * @param int $bid_id Bid ID
     * @param string $revision_notes Revision notes
     * @return bool True on success, false on failure
     */
    public function request_revision($bid_id, $revision_notes) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        $update_data = array(
            'status' => 'revision_requested',
            'revision_notes' => sanitize_textarea_field($revision_notes),
            'reviewed_at' => current_time('mysql'),
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $bid_id));
        
        if ($result !== false) {
            do_action('kpt_bid_revision_requested', $bid_id, $revision_notes);
            
            // Send notification
            $this->send_bid_notification($bid_id, 'revision_requested');
        }
        
        return $result !== false;
    }
    
    /**
     * Calculate bid totals
     *
     * @param array $line_items Line items
     * @return array Totals (subtotal, tax, total)
     */
    private function calculate_totals($line_items) {
        $subtotal = 0;
        
        foreach ($line_items as $item) {
            if (isset($item['quantity']) && isset($item['unit_price'])) {
                $subtotal += floatval($item['quantity']) * floatval($item['unit_price']);
            }
        }
        
        // Get tax rate from settings
        $settings = get_option('kpt_settings', array());
        $tax_rate = isset($settings['tax_rate']) ? floatval($settings['tax_rate']) : 13;
        
        $tax = $subtotal * ($tax_rate / 100);
        $total = $subtotal + $tax;
        
        return array(
            'subtotal' => round($subtotal, 2),
            'tax' => round($tax, 2),
            'total' => round($total, 2),
        );
    }
    
    /**
     * Generate bid number
     *
     * @return string Bid number
     */
    private function generate_bid_number() {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_trade_bids';
        
        $count = $wpdb->get_var("SELECT COUNT(*) FROM $table");
        $number = str_pad($count + 1, 6, '0', STR_PAD_LEFT);
        
        return 'BID-' . date('Y') . '-' . $number;
    }
    
    /**
     * Get line item templates for a trade type
     *
     * @param string $trade_type Trade type
     * @return array Line item templates
     */
    public function get_line_item_templates($trade_type) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_bid_line_items';
        
        return $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM $table WHERE trade_type = %s ORDER BY sort_order ASC, id ASC",
            $trade_type
        ));
    }
    
    /**
     * Send bid notification
     *
     * @param int $bid_id Bid ID
     * @param string $action Action type
     */
    private function send_bid_notification($bid_id, $action) {
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return;
        }
        
        $project = get_post($bid->project_id);
        if (!$project) {
            return;
        }
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        
        // Determine recipient based on action
        if ($action === 'submitted') {
            // Notify project owner
            $owner = get_userdata($project->post_author);
            if ($owner) {
                $notification_handler->send_notification(
                    $owner->user_email,
                    sprintf(__('New bid submitted for project: %s', 'kelbe-project-tracker'), $project->post_title),
                    'bid_submitted',
                    array(
                        'project_id' => $bid->project_id,
                        'project_title' => $project->post_title,
                        'bid_id' => $bid_id,
                        'bid_number' => $bid->bid_number,
                        'trade_type' => $bid->trade_type,
                        'total' => $bid->total,
                    )
                );
            }
        } else {
            // Notify trade user
            $trade_user = get_userdata($bid->trade_user_id);
            if ($trade_user) {
                $notification_handler->send_notification(
                    $trade_user->user_email,
                    sprintf(__('Bid %s: %s', 'kelbe-project-tracker'), ucfirst(str_replace('_', ' ', $action)), $bid->bid_number),
                    'bid_' . $action,
                    array(
                        'project_id' => $bid->project_id,
                        'project_title' => $project->post_title,
                        'bid_id' => $bid_id,
                        'bid_number' => $bid->bid_number,
                        'revision_notes' => isset($bid->revision_notes) ? $bid->revision_notes : '',
                    )
                );
            }
        }
    }
    
    /**
     * AJAX: Create bid
     */
    public function ajax_create_bid() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id) {
            wp_send_json_error(__('Project ID is required.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'project_id' => $project_id,
            'trade_type' => isset($_POST['trade_type']) ? sanitize_text_field($_POST['trade_type']) : '',
            'line_items' => isset($_POST['line_items']) ? $_POST['line_items'] : array(),
            'notes' => isset($_POST['notes']) ? sanitize_textarea_field($_POST['notes']) : '',
        );
        
        $bid_id = $this->create_bid($data);
        
        if ($bid_id) {
            wp_send_json_success(array(
                'message' => __('Bid created.', 'kelbe-project-tracker'),
                'bid_id' => $bid_id,
                'bid' => $this->get_bid($bid_id),
            ));
        } else {
            wp_send_json_error(__('Failed to create bid.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Update bid
     */
    public function ajax_update_bid() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $bid_id = isset($_POST['bid_id']) ? absint($_POST['bid_id']) : 0;
        $bid = $this->get_bid($bid_id);
        
        if (!$bid || !$this->user_can_edit_bid($bid_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array();
        
        if (isset($_POST['trade_type'])) {
            $data['trade_type'] = sanitize_text_field($_POST['trade_type']);
        }
        
        if (isset($_POST['line_items'])) {
            $data['line_items'] = $_POST['line_items'];
        }
        
        if (isset($_POST['notes'])) {
            $data['notes'] = sanitize_textarea_field($_POST['notes']);
        }
        
        if ($this->update_bid($bid_id, $data)) {
            wp_send_json_success(array(
                'message' => __('Bid updated.', 'kelbe-project-tracker'),
                'bid' => $this->get_bid($bid_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update bid.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Delete bid
     */
    public function ajax_delete_bid() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $bid_id = isset($_POST['bid_id']) ? absint($_POST['bid_id']) : 0;
        
        if (!$this->user_can_edit_bid($bid_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->delete_bid($bid_id)) {
            wp_send_json_success(__('Bid deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete bid.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Submit bid
     */
    public function ajax_submit_bid() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $bid_id = isset($_POST['bid_id']) ? absint($_POST['bid_id']) : 0;
        
        if (!$this->user_can_edit_bid($bid_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->submit_bid($bid_id)) {
            wp_send_json_success(array(
                'message' => __('Bid submitted.', 'kelbe-project-tracker'),
                'bid' => $this->get_bid($bid_id),
            ));
        } else {
            wp_send_json_error(__('Failed to submit bid.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Accept bid
     */
    public function ajax_accept_bid() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $bid_id = isset($_POST['bid_id']) ? absint($_POST['bid_id']) : 0;
        $bid = $this->get_bid($bid_id);
        
        if (!$bid || !$this->user_can_review_bid($bid->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $user_id = get_current_user_id();
        
        if ($this->accept_bid($bid_id, $user_id)) {
            wp_send_json_success(array(
                'message' => __('Bid accepted.', 'kelbe-project-tracker'),
                'bid' => $this->get_bid($bid_id),
            ));
        } else {
            wp_send_json_error(__('Failed to accept bid.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Reject bid
     */
    public function ajax_reject_bid() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $bid_id = isset($_POST['bid_id']) ? absint($_POST['bid_id']) : 0;
        $bid = $this->get_bid($bid_id);
        
        if (!$bid || !$this->user_can_review_bid($bid->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $user_id = get_current_user_id();
        
        if ($this->reject_bid($bid_id, $user_id)) {
            wp_send_json_success(array(
                'message' => __('Bid rejected.', 'kelbe-project-tracker'),
                'bid' => $this->get_bid($bid_id),
            ));
        } else {
            wp_send_json_error(__('Failed to reject bid.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Request revision
     */
    public function ajax_request_revision() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $bid_id = isset($_POST['bid_id']) ? absint($_POST['bid_id']) : 0;
        $bid = $this->get_bid($bid_id);
        
        if (!$bid || !$this->user_can_review_bid($bid->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $revision_notes = isset($_POST['revision_notes']) ? sanitize_textarea_field($_POST['revision_notes']) : '';
        
        if ($this->request_revision($bid_id, $revision_notes)) {
            wp_send_json_success(array(
                'message' => __('Revision requested.', 'kelbe-project-tracker'),
                'bid' => $this->get_bid($bid_id),
            ));
        } else {
            wp_send_json_error(__('Failed to request revision.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * Check if user can edit bid
     *
     * @param int $bid_id Bid ID
     * @return bool True if user can edit, false otherwise
     */
    private function user_can_edit_bid($bid_id) {
        $user_id = get_current_user_id();
        
        // Admins can always edit
        if (current_user_can('manage_options')) {
            return true;
        }
        
        $bid = $this->get_bid($bid_id);
        if (!$bid) {
            return false;
        }
        
        // Bid owner can edit their own bids
        return $bid->trade_user_id == $user_id;
    }
    
    /**
     * Check if user can review bid
     *
     * @param int $project_id Project ID
     * @return bool True if user can review, false otherwise
     */
    private function user_can_review_bid($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always review
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can review
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        return false;
    }
}
